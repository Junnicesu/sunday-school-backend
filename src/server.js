const express = require('express');
const session = require('express-session');
const db = require('./db');
const crypto = require('crypto');
const qr = require('qrcode');
const bcrypt = require('bcrypt');
const cors = require('cors');
const app = express();

// Enable CORS for requests from http://sundayschool.gpc.org:4000
app.use(cors({
    origin: 'http://sundayschool.gpc.org:4000',
    credentials: true
}));

app.use(express.json());
app.use(session({
    secret: 'sunday_school_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// Promisify db methods for async/await
const util = require('util');
const dbGet = util.promisify(db.get.bind(db));
const dbAll = util.promisify(db.all.bind(db));
// Custom dbRun function
const dbRun = (sql, params) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) {
                reject(err);
            } else {
                resolve({ lastID: this.lastID, changes: this.changes });
            }
        });
    });
};

// Middleware to require teacher authentication
const requireTeacher = (req, res, next) => {
    if (req.session.teacher) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Get all rooms
app.get('/rooms', async (req, res) => {
    try {
        const rows = await dbAll('SELECT id, name FROM rooms');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Register caregiver and kid (updated to include room_id)
app.post('/register', async (req, res) => {
    const { caregiver_name, caregiver_contact, kid_name, room_id, family_code } = req.body;

    if (!caregiver_name || !caregiver_contact) {
        return res.status(400).json({ error: 'Missing caregiver information' });
    }

    try {
        // Find or create caregiver
        let caregiver = await dbGet('SELECT id FROM caregivers WHERE contact_number = ?', [caregiver_contact]);
        if (!caregiver) {
            const result = await dbRun('INSERT INTO caregivers (name, contact_number) VALUES (?, ?)', [caregiver_name, caregiver_contact]);
            caregiver = { id: result.lastID };
        } else {
            await dbRun('UPDATE caregivers SET name = ? WHERE id = ?', [caregiver_name, caregiver.id]);
        }

        if (family_code) {
            // Link to existing kid
            const kid = await dbGet('SELECT id FROM kids WHERE family_code = ?', [family_code]);
            if (!kid) {
                return res.status(404).json({ error: 'Family code not found' });
            }
            await dbRun('INSERT OR IGNORE INTO kid_caregiver (kid_id, caregiver_id) VALUES (?, ?)', [kid.id, caregiver.id]);
            return res.json({ message: 'Linked to existing kid' });
        } else {
            if (!kid_name || !room_id) {
                return res.status(400).json({ error: 'Missing kid name or room ID' });
            }
            // Create new kid
            const familyCode = crypto.randomBytes(4).toString('hex');
            const kidResult = await dbRun('INSERT INTO kids (name, family_code, room_id) VALUES (?, ?, ?)', [kid_name, familyCode, room_id]);
            const kidId = kidResult.lastID;
            await dbRun('INSERT INTO kid_caregiver (kid_id, caregiver_id) VALUES (?, ?)', [kidId, caregiver.id]);
            return res.json({ message: 'Registration successful', family_code: familyCode });
        }
    } catch (err) {
        console.error('Registration error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get kids associated with a caregiver (updated to include room info)
app.get('/kids', async (req, res) => {
    const { contact_number } = req.query;
    if (!contact_number) {
        return res.status(400).json({ error: 'Missing contact number' });
    }

    try {
        const caregiver = await dbGet('SELECT id FROM caregivers WHERE contact_number = ?', [contact_number]);
        if (!caregiver) {
            return res.status(404).json({ error: 'Caregiver not found' });
        }

        const kids = await dbAll(`
            SELECT k.id, k.name, k.family_code, r.id AS room_id, r.name AS room_name
            FROM kids k
            JOIN kid_caregiver kc ON k.id = kc.kid_id
            JOIN rooms r ON k.room_id = r.id
            WHERE kc.caregiver_id = ?`,
            [caregiver.id]
        );
        res.json(kids);
    } catch (err) {
        console.error('Error fetching kids:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get kids for a room after QR scan
app.get('/kids-for-room', async (req, res) => {
    const { contact_number, room_id } = req.query;
    if (!contact_number || !room_id) {
        return res.status(400).json({ error: 'Missing contact number or room ID' });
    }

    try {
        const caregiver = await dbGet('SELECT id FROM caregivers WHERE contact_number = ?', [contact_number]);
        if (!caregiver) {
            return res.status(404).json({ error: 'Caregiver not found' });
        }

        const kids = await dbAll(`
            SELECT k.id, k.name, r.name AS room_name,
                   (SELECT action FROM sign_in_out_records 
                    WHERE kid_id = k.id AND room_id = r.id 
                    ORDER BY timestamp DESC LIMIT 1) AS last_action
            FROM kids k
            JOIN kid_caregiver kc ON k.id = kc.kid_id
            JOIN rooms r ON k.room_id = r.id
            WHERE kc.caregiver_id = ? AND k.room_id = ?`,
            [caregiver.id, room_id]
        );
        res.json(kids);
    } catch (err) {
        console.error('Error fetching kids for room:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Sign in/out kids
app.post('/sign', async (req, res) => {
    const { caregiver_contact, room_id, kid_ids, action } = req.body;
    if (!caregiver_contact || !room_id || !kid_ids || !action || (action !== 'in' && action !== 'out')) {
        return res.status(400).json({ error: 'Invalid request data' });
    }

    try {
        const room = await dbGet('SELECT name FROM rooms WHERE id = ?', [room_id]);
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }        

        // Step 1: Look up the caregiver_id based on caregiver_contact
        const caregiver = await dbGet(
            'SELECT id FROM caregivers WHERE contact_number = ?',
            [caregiver_contact]
        );
        if (!caregiver) {
            return res.status(400).json({ error: 'Caregiver not found' });
        }
        const caregiver_id = caregiver.id;

        // Step 2: Validate that the caregiver is associated with each kid
        for (const kid_id of kid_ids) {
            const association = await dbGet(
                'SELECT 1 FROM kid_caregiver WHERE kid_id = ? AND caregiver_id = ?',
                [kid_id, caregiver_id]
            );
            if (!association) {
                return res.status(403).json({ error: `Caregiver not authorized to sign in/out kid with ID ${kid_id}` });
            }
        }

        // Step 3: Insert sign-in/out records for each kid
        const actions = [];
        for (const kid_id of kid_ids) {
            const kid = await dbGet('SELECT name FROM kids WHERE id = ? AND room_id = ?', [kid_id, room_id]);
            if (kid) {
                await dbRun(
                    'INSERT INTO sign_in_out_records (kid_id, room_id, caregiver_id, action) VALUES (?, ?, ?, ?)',
                    [kid_id, room_id, caregiver_id, action]
                );
                actions.push(`${kid.name} has been signed ${action} of ${room.name}`);
            }
        }

        if (actions.length === 0) {
            return res.status(404).json({ error: 'No valid kids selected for this room' });
        }

        res.json({ message: actions.join(' and ') });
    } catch (err) {
        console.error('Sign-in/out error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Teacher login
app.post('/teacher/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Missing credentials' });
    }

    try {
        const teacher = await dbGet('SELECT * FROM teachers WHERE username = ?', [username]);
        if (teacher && bcrypt.compareSync(password, teacher.password_hash)) {
            req.session.teacher = teacher.id;
            return res.json({ message: 'Login successful' });
        }
        res.status(401).json({ error: 'Invalid credentials' });
    } catch (err) {
        console.error('Teacher login error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get real-time attendance for a room
app.get('/attendance/:room_id', requireTeacher, async (req, res) => {
    const { room_id } = req.params;
    try {
        const attendance = await dbAll(`
            SELECT 
                k.id, 
                k.name AS kid_name,
                (SELECT r.action 
                 FROM sign_in_out_records r 
                 WHERE r.kid_id = k.id 
                 AND r.room_id = ? 
                 AND DATE(r.timestamp) = DATE('now') 
                 ORDER BY r.timestamp DESC 
                 LIMIT 1) AS last_action,
                (SELECT c2.name 
                 FROM sign_in_out_records r 
                 LEFT JOIN caregivers c2 ON r.caregiver_id = c2.id
                 WHERE r.kid_id = k.id 
                 AND r.room_id = ? 
                 AND DATE(r.timestamp) = DATE('now') 
                 AND r.action = 'in'
                 ORDER BY r.timestamp DESC 
                 LIMIT 1) AS last_signin_caregiver_name,
                (SELECT c2.contact_number 
                 FROM sign_in_out_records r 
                 LEFT JOIN caregivers c2 ON r.caregiver_id = c2.id
                 WHERE r.kid_id = k.id 
                 AND r.room_id = ? 
                 AND DATE(r.timestamp) = DATE('now') 
                 AND r.action = 'in'
                 ORDER BY r.timestamp DESC 
                 LIMIT 1) AS last_signin_caregiver_contact,
                (SELECT c2.name 
                 FROM sign_in_out_records r 
                 LEFT JOIN caregivers c2 ON r.caregiver_id = c2.id
                 WHERE r.kid_id = k.id 
                 AND r.room_id = ? 
                 AND DATE(r.timestamp) = DATE('now') 
                 AND r.action = 'out'
                 ORDER BY r.timestamp DESC 
                 LIMIT 1) AS last_signout_caregiver_name,
                (SELECT c2.contact_number 
                 FROM sign_in_out_records r 
                 LEFT JOIN caregivers c2 ON r.caregiver_id = c2.id
                 WHERE r.kid_id = k.id 
                 AND r.room_id = ? 
                 AND DATE(r.timestamp) = DATE('now') 
                 AND r.action = 'out'
                 ORDER BY r.timestamp DESC 
                 LIMIT 1) AS last_signout_caregiver_contact
            FROM kids k
            WHERE k.room_id = ?
            AND EXISTS (
                SELECT 1 
                FROM sign_in_out_records r2 
                WHERE r2.kid_id = k.id 
                AND r2.room_id = ? 
                AND DATE(r2.timestamp) = DATE('now')
            )`,
            [room_id, room_id, room_id, room_id, room_id, room_id, room_id]
        );
        res.json(attendance);
    } catch (err) {
        console.error('Attendance error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// QR code generation
app.get('/qr/:room_id', requireTeacher, async (req, res) => {
    const { room_id } = req.params;
    try {
        const url = `http://sundayschool.gpc.org:4000/room/${room_id}`; // Single URL per room
        const qrCodeUrl = await new Promise((resolve, reject) => {
            qr.toDataURL(url, (err, url) => {
                if (err) reject(err);
                else resolve(url);
            });
        });
        res.send(`
            <html>
                <body>
                    <h1>QR Code for Room ${room_id}</h1>
                    <img src="${qrCodeUrl}" alt="QR Code for Room ${room_id}" />
                    <button onclick="window.print()">Print</button>
                </body>
            </html>
        `);
    } catch (err) {
        console.error('QR code generation error:', err.message);
        res.status(500).json({ error: 'Error generating QR code' });
    }
});

app.listen(3000, () => console.log('Server running on port 3000'));