const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sunday_school.db'); // Adjust path to your database
const bcrypt = require('bcrypt');
const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
});

// Function to hash passwords securely
const hashPassword = (password) => bcrypt.hashSync(password, 10);

// Function to create a new teacher account
const createTeacher = (username, password) => {
    const passwordHash = hashPassword(password);
    db.run('INSERT INTO teachers (username, password_hash) VALUES (?, ?)', [username, passwordHash], (err) => {
        if (err) {
            console.error(`Error creating teacher ${username}: ${err.message}`);
        } else {
            console.log(`Teacher ${username} created successfully.`);
        }
        readline.close();
    });
};

// Function to update a teacher’s password
const updateTeacherPassword = (username, newPassword) => {
    const passwordHash = hashPassword(newPassword);
    db.run('UPDATE teachers SET password_hash = ? WHERE username = ?', [passwordHash, username], function(err) {
        if (err) {
            console.error(`Error updating ${username}: ${err.message}`);
        } else if (this.changes > 0) {
            console.log(`Password for ${username} updated successfully.`);
        } else {
            console.log(`Teacher ${username} not found.`);
        }
        readline.close();
    });
};

// Function to delete a teacher account
const deleteTeacher = (username) => {
    db.run('DELETE FROM teachers WHERE username = ?', [username], function(err) {
        if (err) {
            console.error(`Error deleting ${username}: ${err.message}`);
        } else if (this.changes > 0) {
            console.log(`Teacher ${username} deleted successfully.`);
        } else {
            console.log(`Teacher ${username} not found.`);
        }
        readline.close();
    });
};

// Prompt the user for input
readline.question('Enter action (create/update/delete): ', (action) => {
    if (action === 'create') {
        readline.question('Enter username: ', (username) => {
            readline.question('Enter password: ', (password) => {
                createTeacher(username, password);
            });
        });
    } else if (action === 'update') {
        readline.question('Enter username: ', (username) => {
            readline.question('Enter new password: ', (newPassword) => {
                updateTeacherPassword(username, newPassword);
            });
        });
    } else if (action === 'delete') {
        readline.question('Enter username: ', (username) => {
            deleteTeacher(username);
        });
    } else {
        console.log('Invalid action. Use create, update, or delete.');
        readline.close();
    }
});