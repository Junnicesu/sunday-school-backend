const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('sunday_school.db');

db.serialize(() => {
    // Caregivers table
    db.run(`
        CREATE TABLE IF NOT EXISTS caregivers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            contact_number TEXT UNIQUE NOT NULL
        )
    `);

    // Kids table (added room_id for room assignment)
    db.run(`
        CREATE TABLE IF NOT EXISTS kids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            family_code TEXT UNIQUE NOT NULL,
            room_id INTEGER,
            FOREIGN KEY (room_id) REFERENCES rooms(id)
        )
    `);

    // Rooms table
    db.run(`
        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL
        )
    `);

    // Kid-Caregiver relationship table
    db.run(`
        CREATE TABLE IF NOT EXISTS kid_caregiver (
            kid_id INTEGER,
            caregiver_id INTEGER,
            PRIMARY KEY (kid_id, caregiver_id),
            FOREIGN KEY (kid_id) REFERENCES kids(id),
            FOREIGN KEY (caregiver_id) REFERENCES caregivers(id)
        )
    `);

    // Sign-in/out records table
    db.run(`
        CREATE TABLE IF NOT EXISTS sign_in_out_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kid_id INTEGER,
            room_id INTEGER,
            action TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (kid_id) REFERENCES kids(id),
            FOREIGN KEY (room_id) REFERENCES rooms(id)
        )
    `);

    // Teachers table
    db.run(`
        CREATE TABLE IF NOT EXISTS teachers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        )
    `);

    // Seed initial data
    db.prepare('INSERT OR IGNORE INTO rooms (id, name) VALUES (1, "Room A")').run();
    db.prepare('INSERT OR IGNORE INTO rooms (id, name) VALUES (2, "Room B")').run();

    // Seed a teacher account (username: "teacher", password: "teacherpass")
    const bcrypt = require('bcrypt');
    const passwordHash = bcrypt.hashSync('teacherpass', 10);
    db.prepare('INSERT OR IGNORE INTO teachers (username, password_hash) VALUES ("teacher", ?)').run(passwordHash);
});

module.exports = db;

console.log(db.prepare("SELECT * FROM rooms").all());