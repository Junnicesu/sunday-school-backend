const sqlite = require('better-sqlite3');
const db = sqlite('sunday_school.db');

// Create tables if they don’t exist
db.exec(`
  CREATE TABLE IF NOT EXISTS caregivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact_number TEXT UNIQUE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    family_code TEXT UNIQUE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kid_caregiver (
    kid_id INTEGER,
    caregiver_id INTEGER,
    PRIMARY KEY (kid_id, caregiver_id),
    FOREIGN KEY (kid_id) REFERENCES kids(id),
    FOREIGN KEY (caregiver_id) REFERENCES caregivers(id)
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sign_in_out_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kid_id INTEGER,
    room_id INTEGER,
    action TEXT CHECK (action IN ('in', 'out')),
    timestamp TEXT,
    FOREIGN KEY (kid_id) REFERENCES kids(id),
    FOREIGN KEY (room_id) REFERENCES rooms(id)
  );
  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );
`);

// Seed initial data
// Rooms
db.prepare("INSERT OR IGNORE INTO rooms (id, name) VALUES (1, 'Room A')").run();
db.prepare("INSERT OR IGNORE INTO rooms (id, name) VALUES (2, 'Room B')").run();

// Teacher account (username: "teacher", password: "teacherpass")
const bcrypt = require('bcrypt');
const passwordHash = bcrypt.hashSync('teacherpass', 10);
db.prepare("INSERT OR IGNORE INTO teachers (username, password_hash) VALUES ('teacher', ?)").run(passwordHash);

module.exports = db;

console.log(db.prepare("SELECT * FROM rooms").all());