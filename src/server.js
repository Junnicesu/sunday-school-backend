const express = require('express');
const session = require('express-session');
const db = require('./db');
const crypto = require('crypto');
const qr = require('qrcode');
const bcrypt = require('bcrypt');
const app = express();

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

// Register caregiver and kid
app.post('/register', (req, res) => {
    const { caregiver_name, caregiver_contact, kid_name, family_code } = req.body;

    if (!caregiver_name || !caregiver_contact) {
        return res.status(400).json({ error: 'Missing caregiver information' });
    }

    // Find or create caregiver
    let caregiver = db.prepare('SELECT id FROM caregivers WHERE contact_number = ?').get(caregiver_contact);
    if (!caregiver) {
        const result = db.prepare('INSERT INTO caregivers (name, contact_number) VALUES (?, ?)').run(caregiver_name, caregiver_contact);
        caregiver = { id: result.lastInsertRowid };
    } else {
        db.prepare('UPDATE caregivers SET name = ? WHERE id = ?').run(caregiver_name, caregiver.id);
    }

    if (family_code) {
        // Link to existing kid
        const kid = db.prepare('SELECT id FROM kids WHERE family_code = ?').get(family_code);
        if (!kid) {
            return res.status(404).json({ error: 'Family code not found' });
        }
        db.prepare('INSERT OR IGNORE INTO kid_caregiver (kid_id, caregiver_id) VALUES (?, ?)').run(kid.id, caregiver.id);
        return res.json({ message: 'Linked to existing kid' });
    } else {
        if (!kid_name) {
            return res.status(400).json({ error: 'Missing kid name' });
        }
        // Create new kid
        const familyCode = crypto.randomBytes(4).toString('hex');
        const kidResult = db.prepare('INSERT INTO kids (name, family_code) VALUES (?, ?)').run(kid_name, familyCode);
        const kidId = kidResult.lastInsertRowid;
        db.prepare('INSERT INTO kid_caregiver (kid_id, caregiver_id) VALUES (?, ?)').run(kidId, caregiver.id);
        return res.json({ message: 'Registration successful', family_code: familyCode });
    }
});

// Get kids associated with a caregiver
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
    SELECT k.id, k.name
    FROM kids k
    JOIN kid_caregiver kc ON k.id = kc.kid_id
    WHERE kc.caregiver_id = ?
  `).all(caregiver.id);
    res.json(kids);
});

// Record sign-in or sign-out
app.post('/sign', (req, res) => {
    const { kid_id, room_id, action } = req.body;
    if (!kid_id || !room_id || !action || (action !== 'in' && action !== 'out')) {
        return res.status(400).json({ error: 'Invalid request data' });
    }
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(room_id);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    db.prepare('INSERT INTO sign_in_out_records (kid_id, room_id, action, timestamp) VALUES (?, ?, ?, datetime("now"))')
        .run(kid_id, room_id, action);
    res.json({ message: 'Action recorded' });
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
      SELECT 1
      FROM sign_in_out_records r
      WHERE r.kid_id = k.id
      AND r.room_id = ?
      AND DATE(r.timestamp) = DATE('now')
      AND r.timestamp = (
        SELECT MAX(timestamp)
        FROM sign_in_out_records
        WHERE kid_id = k.id AND room_id = ? AND DATE(timestamp) = DATE('now')
      )
      AND r.action = 'in'
    )
  `).all(room_id, room_id);
    res.json(attendance);
});

// Generate QR code for a room
app.get('/qr/:room_id', requireTeacher, (req, res) => {
    const { room_id } = req.params;
    qr.toDataURL(`room:${room_id}`, (err, url) => {
        if (err) {
            return res.status(500).json({ error: 'Error generating QR code' });
        }
        res.send(`
      <html>
        <body>
          <h1>QR Code for Room ${room_id}</h1>
          <img src="${url}" alt="QR Code for Room ${room_id}" />
          <button onclick="window.print()">Print</button>
        </body>
      </html>
    `);
    });
});

app.listen(3000, () => console.log('Server running on port 3000'));