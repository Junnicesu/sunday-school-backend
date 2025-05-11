const express = require('express');
const session = require('express-session');
const db = require('./db');
const crypto = require('crypto');
const qr = require('qrcode');
const bcrypt = require('bcrypt');
const cors = require('cors');
const app = express();

// Enable CORS for requests from http://localhost:4000
app.use(cors({
    origin: 'http://localhost:4000',
    credentials: true
}));

app.use(express.json());
app.use(session({
    secret: 'sunday_school_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// Middleware to require teacher authentication
const requireTeacher = (req, res, next) => {
    if (req.session.teacher) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

app.get('/rooms', (req, res) => {
    db.all('SELECT id, name FROM rooms', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Register caregiver and kid (updated to include room_id)
app.post('/register', (req, res) => {
    const { caregiver_name, caregiver_contact, kid_name, room_id, family_code } = req.body;

    if (!caregiver_name || !caregiver_contact) {
        return res.status(400).json({ error: 'Missing caregiver information' });
    }

    // Find or create caregiver
    let caregiver = db.prepare('SELECT id FROM caregivers WHERE contact_number = ?').get(caregiver_contact);
    if (!caregiver || Object.keys(caregiver).length ==0) {
        const result = db.prepare('INSERT INTO caregivers (name, contact_number) VALUES (?, ?)').run(caregiver_name, caregiver_contact);
        caregiver = { id: result.lastInsertRowid };
    } else {
        db.prepare('UPDATE caregivers SET name = ? WHERE id = ?').run(caregiver_name, caregiver.id);
    }

    if (family_code) {
        // Link to existing kid
        const kid = db.prepare('SELECT id FROM kids WHERE family_code = ?').get(family_code);
        if (!kid && Object.keys(kid).length !=0) {
            return res.status(404).json({ error: 'Family code not found' });
        }
        db.prepare('INSERT OR IGNORE INTO kid_caregiver (kid_id, caregiver_id) VALUES (?, ?)').run(kid.id, caregiver.id);
        return res.json({ message: 'Linked to existing kid' });
    } else {
        if (!kid_name || !room_id) {
            return res.status(400).json({ error: 'Missing kid name or room ID' });
        }
        // Create new kid
        const familyCode = crypto.randomBytes(4).toString('hex');
        const kidResult = db.prepare('INSERT INTO kids (name, family_code, room_id) VALUES (?, ?, ?)').run(kid_name, familyCode, room_id);
        const kidId = kidResult.lastInsertRowid;
        db.prepare('INSERT INTO kid_caregiver (kid_id, caregiver_id) VALUES (?, ?)').run(kidId, caregiver.id);
        return res.json({ message: 'Registration successful', family_code: familyCode });
    }
});

// Get kids associated with a caregiver (updated to include room info)
app.get('/kids', (req, res) => {
    const { contact_number } = req.query;
    if (!contact_number) {
        return res.status(400).json({ error: 'Missing contact number' });
    }
    const caregiver = db.prepare('SELECT id FROM caregivers WHERE contact_number = ?').get(contact_number);
    if (!caregiver) {
        return res.status(404).json({ error: 'Caregiver not found' });
    }
    const kids = db.prepare(`
        SELECT k.id, k.name, r.id AS room_id, r.name AS room_name
        FROM kids k
        JOIN kid_caregiver kc ON k.id = kc.kid_id
        JOIN rooms r ON k.room_id = r.id
        WHERE kc.caregiver_id = ?
    `).all(caregiver.id);
    res.json(kids);
});

// Get kids for a room after QR scan (new endpoint)
app.get('/kids-for-room', (req, res) => {
    const { contact_number, room_id } = req.query;
    if (!contact_number || !room_id) {
        return res.status(400).json({ error: 'Missing contact number or room ID' });
    }
    const caregiver = db.prepare('SELECT id FROM caregivers WHERE contact_number = ?').get(contact_number);
    if (!caregiver) {
        return res.status(404).json({ error: 'Caregiver not found' });
    }
    const kids = db.prepare(`
        SELECT k.id, k.name, r.name AS room_name,
               (SELECT action FROM sign_in_out_records WHERE kid_id = k.id AND room_id = r.id 
                ORDER BY timestamp DESC LIMIT 1) AS last_action
        FROM kids k
        JOIN kid_caregiver kc ON k.id = kc.kid_id
        JOIN rooms r ON k.room_id = r.id
        WHERE kc.caregiver_id = ? AND k.room_id = ?
    `).all(caregiver.id, room_id);
    res.json(kids);
});

// Updated /sign endpoint for selective actions
app.post('/sign', (req, res) => {
    const { caregiver_contact, room_id, kid_ids, action } = req.body;
    if (!caregiver_contact || !room_id || !kid_ids || !action || (action !== 'in' && action !== 'out')) {
        return res.status(400).json({ error: 'Invalid request data' });
    }

    const caregiver = db.prepare('SELECT id FROM caregivers WHERE contact_number = ?').get(caregiver_contact);
    if (!caregiver) {
        return res.status(404).json({ error: 'Caregiver not found' });
    }

    const room = db.prepare('SELECT name FROM rooms WHERE id = ?').get(room_id);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const actions = [];
    kid_ids.forEach(kid_id => {
        const kid = db.prepare('SELECT name FROM kids WHERE id = ? AND room_id = ?').get(kid_id, room_id);
        if (kid) {
            db.prepare('INSERT INTO sign_in_out_records (kid_id, room_id, action, timestamp) VALUES (?, ?, ?, datetime("now"))')
                .run(kid_id, room_id, action);
            actions.push(`${kid.name} has been signed ${action} of ${room.name}`);
        }
    });

    if (actions.length === 0) {
        return res.status(404).json({ error: 'No valid kids selected for this room' });
    }

    res.json({ message: actions.join(' and ') });
});

// Teacher login
app.post('/teacher/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Missing credentials' });
    }
    const teacher = db.prepare('SELECT * FROM teachers WHERE username = ?').get(username);
    if (teacher && bcrypt.compareSync(password, teacher.password_hash)) {
        req.session.teacher = teacher.id;
        return res.json({ message: 'Login successful' });
    }
    res.status(401).json({ error: 'Invalid credentials' });
});

// Get real-time attendance for a room
app.get('/attendance/:room_id', requireTeacher, (req, res) => {
    const { room_id } = req.params;
    const attendance = db.prepare(`
        SELECT k.id, k.name
        FROM kids k
        WHERE EXISTS (
            SELECT 1 FROM sign_in_out_records r
            WHERE r.kid_id = k.id AND r.room_id = ?
            AND DATE(r.timestamp) = DATE('now')
            AND r.timestamp = (
                SELECT MAX(timestamp) FROM sign_in_out_records
                WHERE kid_id = k.id AND room_id = ? AND DATE(timestamp) = DATE('now')
            )
            AND r.action = 'in'
        )
    `).all(room_id, room_id);
    res.json(attendance);
});

// Updated QR code generation (includes action)
app.get('/qr/:room_id/:action', requireTeacher, (req, res) => {
    const { room_id, action } = req.params;
    if (action !== 'in' && action !== 'out') {
        return res.status(400).json({ error: 'Invalid action' });
    }
    qr.toDataURL(`room:${room_id}:action:${action}`, (err, url) => {
        if (err) {
            return res.status(500).json({ error: 'Error generating QR code' });
        }
        res.send(`
            <html>
                <body>
                    <h1>QR Code for Room ${room_id} - Sign ${action}</h1>
                    <img src="${url}" alt="QR Code for Room ${room_id} - Sign ${action}" />
                    <button onclick="window.print()">Print</button>
                </body>
            </html>
        `);
    });
});

app.listen(3000, () => console.log('Server running on port 3000'));
