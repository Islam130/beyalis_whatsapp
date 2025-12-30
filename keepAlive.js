const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const database = require('./config/database');
const fs = require('fs');

// Configuration
const MIN_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const MAX_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// Store active sockets
const sessionSockets = new Map();

// Generate random string of specified length
function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Generate random interval between min and max
function getRandomInterval() {
    return Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS + 1)) + MIN_INTERVAL_MS;
}

// Get or create socket for a session
async function getSocket(sessionId) {
    // Check if we already have an active socket
    if (sessionSockets.has(sessionId)) {
        const sock = sessionSockets.get(sessionId);
        if (sock.user) {
            return sock;
        }
    }

    // Create new socket connection
    const authDir = `auth_info_baileys_${sessionId}`;

    if (!fs.existsSync(authDir)) {
        console.log(`  Auth directory not found for session ${sessionId}`);
        return null;
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            defaultQueryTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        // Wait for connection
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 30000);

            sock.ev.on('connection.update', (update) => {
                if (update.connection === 'open') {
                    clearTimeout(timeout);
                    resolve();
                }
                if (update.connection === 'close') {
                    clearTimeout(timeout);
                    reject(new Error('Connection closed'));
                }
            });
        });

        sessionSockets.set(sessionId, sock);
        return sock;
    } catch (error) {
        console.log(`  Failed to connect session ${sessionId}: ${error.message}`);
        return null;
    }
}

// Send simple text message directly via socket
async function sendSimpleText(sessionId, phone, text) {
    try {
        const sock = await getSocket(sessionId);
        if (!sock) {
            return { success: false, error: 'Socket not available' };
        }

        // Format phone to JID
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

        // Send simple text message
        const result = await sock.sendMessage(jid, { text: text });

        return { success: true, messageId: result?.key?.id };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Main function to process ready sessions
async function processReadySessions() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${new Date().toISOString()}] Running keep-alive check...`);
    console.log(`${'='.repeat(60)}`);

    try {
        // Get all ready sessions with their phone numbers
        const [sessions] = await database.pool.execute(
            'SELECT id, phone_number FROM sessions WHERE ready = 1 AND phone_number IS NOT NULL'
        );

        if (sessions.length === 0) {
            console.log('No ready sessions found.');
            scheduleNext();
            return;
        }

        console.log(`Found ${sessions.length} ready session(s)`);

        for (const session of sessions) {
            // Skip if no phone number
            if (!session.phone_number) {
                console.log(`\nSession ${session.id}: Skipped (no phone number)`);
                continue;
            }

            const randomString = generateRandomString(10);
            const message = `activate ${randomString}`;

            console.log(`\nSession ${session.id} (${session.phone_number}):`);
            console.log(`  Sending to self: "${message}"`);

            // Send simple text message to self
            const result = await sendSimpleText(session.id, session.phone_number, message);

            if (result?.success) {
                console.log(`  Success: Message sent (ID: ${result.messageId})`);
            } else {
                console.log(`  Failed: ${result?.error || 'Unknown error'}`);
            }
        }

    } catch (error) {
        console.error('Error processing sessions:', error.message);
    }

    scheduleNext();
}

// Schedule next execution with random interval
function scheduleNext() {
    const nextInterval = getRandomInterval();
    const nextRunTime = new Date(Date.now() + nextInterval);
    console.log(`\nNext run in ${Math.round(nextInterval / 60000)} minutes (at ${nextRunTime.toLocaleTimeString()})`);
    setTimeout(processReadySessions, nextInterval);
}

// Start the script
console.log('Keep-Alive Script Started');
console.log(`Interval: ${MIN_INTERVAL_MS / 60000}-${MAX_INTERVAL_MS / 60000} minutes`);
console.log('Each session will send a simple text message to itself\n');

// Run immediately on start, then schedule randomly
processReadySessions();
