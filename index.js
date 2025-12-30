const { makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Import our services
const database = require('./config/database');
const s3Service = require('./services/s3Service');
const sessionManager = require('./services/sessionManager');
const phoneResolver = require('./utils/phoneResolver');
const { log } = require('console');

// Create Express app
const app = express();
const PORT = 3001;

// Middleware
app.use(express.json());
// Root endpoint - health checkapp.get('/', (req, res) => {    res.json({ status: 'success', message: 'WhatsApp Bot Server is running' });});

// Runtime storage for active WebSocket connections
// Note: This Map is REQUIRED - WebSocket connections cannot be stored in database
// Database (sessions table) stores: id, phone_number, qr, ready status (persistent data)
// This Map stores: live socket objects with sendMessage(), event listeners, etc. (runtime only)
const sessionSockets = new Map();

// Track last sync time for message recovery
let lastSyncTime = null;
let isFirstConnection = true;



// Function to convert raw WhatsApp QR data to proper QR code image
async function convertRawQRToImage(rawQRData) {
    try {
        console.log(`🔄 Converting raw QR data to image...`);
        console.log(`🔍 Raw QR data: ${rawQRData.substring(0, 50)}...`);
        
        const qrImageBase64 = await QRCode.toDataURL(rawQRData, {
            type: 'image/png',
            quality: 0.92,
            margin: 1,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            },
            width: 256
        });
        
        console.log(`✅ QR code converted successfully`);
        console.log(`📊 Image size: ${qrImageBase64.length} characters`);
        
        return qrImageBase64;
    } catch (error) {
        console.error('❌ Error converting raw QR data to image:', error);
        return null;
    }
}

// Function to convert and display QR code (standalone function)
async function convertAndDisplayQR(rawQRData) {
    try {
        if (!rawQRData) {
            console.error('❌ No raw QR data provided');
            return null;
        }
        
        console.log('\n' + '='.repeat(60));
        console.log('🔄 CONVERTING RAW QR DATA TO IMAGE');
        console.log('='.repeat(60));
        
        // Convert to image
        const qrImageBase64 = await convertRawQRToImage(rawQRData);
        
        if (!qrImageBase64) {
            console.error('❌ Failed to convert QR data to image');
            return null;
        }
        
        // Print QR code to terminal
        printQRCode(rawQRData);
        
        console.log('='.repeat(60));
        console.log('✅ QR CODE CONVERSION COMPLETE');
        console.log(`📊 Image data length: ${qrImageBase64.length} characters`);
        console.log(`🖼️  Image format: PNG (Base64)`);
        console.log('='.repeat(60) + '\n');
        
        return qrImageBase64;
        
    } catch (error) {
        console.error('❌ Error in convertAndDisplayQR:', error);
        return null;
    }
}

// Function to print QR code with simple behavior
function printQRCode(qr) {
    console.log('\n' + '='.repeat(50));
    console.log('📱 WHATSAPP QR CODE - SCAN WITH YOUR PHONE');
    console.log('='.repeat(50));
    
    // Check if this is a real WhatsApp QR code or placeholder
    if (qr.includes('WhatsApp Web - Waiting for connection')) {
        console.log('⏳ This is a placeholder QR code.');
        console.log('⏳ Real QR code will appear when connection is established.');
    } else {
        // Generate QR code in terminal (simple format)
        qrcode.generate(qr, { small: true });
    }
    
    console.log('='.repeat(50));
    console.log('📱 Scan the QR code above with WhatsApp to connect');
    console.log('📱 Open WhatsApp > Settings > Linked Devices > Link a Device');
    console.log('='.repeat(50) + '\n');
}

// Endpoint to create new session
app.post('/session', async (req, res) => {
    try {
        // Create a new session in database with empty QR code initially
        const sessionId = await database.createSession('');
        
        // Set this as the current session in sessionManager
        sessionManager.setCurrentSessionId(sessionId);
        
        console.log(`\n🔄 New session created with ID: ${sessionId}`);
        console.log('⏳ Waiting for WhatsApp connection to generate QR code...');
        
        // Start WhatsApp connection to generate QR code for this session
        await startWhatsAppForSession(sessionId);
        
        res.json({
            success: true,
            message: 'Session created successfully. QR code will be generated when WhatsApp connection is established.',
            sessionId: sessionId,
            qrCode: '',
            note: 'QR code will appear in terminal when WhatsApp connection is established.'
        });
        
    } catch (error) {
        console.error('Error creating session:', error);
        
        // Provide more specific error messages
        let errorMessage = 'Internal server error';
        if (error.message.includes('Failed to create auth directory')) {
            errorMessage = 'Failed to create authentication directory. Please check file permissions.';
        } else if (error.message.includes('ENOENT')) {
            errorMessage = 'File system error: Directory not found or permission denied.';
        } else if (error.message.includes('database')) {
            errorMessage = 'Database error occurred while creating session.';
        }
        
        res.status(500).json({
            success: false,
            message: errorMessage,
            error: error.message
        });
    }
});

// Endpoint to send text message
app.use(express.urlencoded({ extended: true }));

app.post('/session/:id/send-text', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const phone = req.body.to;
        const url = req.body.pdfUrl;
        const fileName = req.body.fileName || 'document.pdf';
        const text = req.body.text || '';

        // 1. Validate input
        if (!phone) {
            return res.status(400).json({ error: 'Missing recipient', message: 'Provide `to` as a phone number' });
        }
        if (!text && !url) {
            return res.status(400).json({ error: 'Missing text/pdf', message: 'Provide `text` or `pdfUrl`' });
        }

        // 2. Get session
        const session = await database.getSession(sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (!session.ready) return res.status(400).json({ error: 'Session not ready' });

        // 3. Get socket
        const sock = sessionSockets.get(parseInt(sessionId));
        if (!sock) return res.status(404).json({ error: 'Session socket not found' });

        // 4. Normalize JID
        function normalizeJid(num) {
            let clean = num.toString().replace(/\D/g, '');
            if (clean.startsWith('0')) clean = '20' + clean.substring(1); // Egypt local numbers
            return clean + '@s.whatsapp.net';
        }
        const toJid = phone.includes('@') ? phone : normalizeJid(phone);

        // 5. Fetch PDF buffer if needed
        async function fetchBuffer(urlStr) {
            const https = require('https');
            const http = require('http');
            return new Promise((resolve, reject) => {
                const lib = urlStr.startsWith('https') ? https : http;
                lib.get(urlStr, (resp) => {
                    if (resp.statusCode !== 200) return reject(new Error('Fetch failed: ' + resp.statusCode));
                    const chunks = [];
                    resp.on('data', (d) => chunks.push(d));
                    resp.on('end', () => resolve(Buffer.concat(chunks)));
                }).on('error', reject);
            });
        }

        let result;
        if (url) {
            const buffer = await fetchBuffer(url);
            const finalFileName = fileName.endsWith('.pdf') ? fileName : fileName + '.pdf';

            result = await sock.sendMessage(toJid, {
                document: buffer,
                mimetype: 'application/pdf',
                fileName: finalFileName,
                caption: text
            });
            console.log(`✅ PDF sent to ${phone}`);
        } else {
            result = await sock.sendMessage(toJid, { text });
            console.log(`✅ Text sent to ${phone}`);
        }

        // 6. Store message + chat in DB
        try {
            const dataSession = await database.getDataSession(sessionId); // fetch once

            const chatId = sessionManager.generateChatId(toJid, sessionId);
            const whatsappMessageId = result?.key?.id || `temp_${Date.now()}`;

            // Try to get WhatsApp profile name of recipient - try multiple methods
            let contactName = toJid.split('@')[0]; // Default to phone number
            
            try {
                // Method 1: Check stored contacts first
                const contacts = sock.store?.contacts || {};
                const contact = contacts[toJid];
                if (contact?.name) {
                    contactName = contact.name;
                } else if (contact?.notify) {
                    contactName = contact.notify;
                }
            } catch (err) {
                // Continue to next method
            }
            
            // Method 2: If still not found, try onWhatsApp
            if (contactName === toJid.split('@')[0]) {
                try {
                    const [waContact] = await sock.onWhatsApp(toJid);
                    if (waContact?.notify) {
                        contactName = waContact.notify;
                    }
                } catch (err) {
                    // Continue to next method
                }
            }
            
            // Method 3: Check database for existing chat with this contact
            if (contactName === toJid.split('@')[0]) {
                try {
                    const existingChat = await database.getChatByPhoneNumber(toJid.split('@')[0], sessionId);
                    if (existingChat?.name && existingChat.name !== toJid.split('@')[0]) {
                        contactName = existingChat.name;
                    }
                } catch (err) {
                    // Use phone number as fallback
                }
            }

            await database.createOrUpdateChat({
                id: chatId,
                sessionId,
                name: contactName,
                phoneNumber: JSON.stringify([toJid.split('@')[0]]),
                isGroup: toJid.endsWith('@g.us') ? 1 : 0,
                lastMessageId: whatsappMessageId,
                lastMessageTimestamp: Math.floor(Date.now() / 1000)
            });
            const fullurl = new URL(url);
            await database.createMessage({
                id: whatsappMessageId,
                chatId,
                sessionId,
                fromNumber: dataSession?.phone_number || 'unknown',
                senderId: dataSession?.phone_number || 'unknown',
                senderName: 'Invoice_sender',
                body: text || `File: ${fileName}`,
                timestamp: Math.floor(Date.now() / 1000),
                fromMe: 1,
                hasMedia: url ? 1 : 0,
                mediaType: url ? 'application/pdf' : null,
                whatsappMessageId,
                mediaPreview: fullurl.href.replace(fullurl.origin, ""),
                parentId: null,
                status: 'sent'
            });

            console.log(`✅ Message stored in DB: ${whatsappMessageId}`);
        } catch (dbError) {
            console.error('❌ Failed to store message in DB:', dbError);
        }

        // 7. Response
        return res.json({
            success: true,
            sessionId,
            to: toJid,
            type: url ? 'pdf' : 'text',
            fileName: url ? fileName : null,
            messageId: result?.key?.id || null
        });

    } catch (err) {
        console.error('❌ Error in send-text:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});


// Endpoint to get session data
app.get('/session/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        // Get session data from database
        const session = await database.getSession(sessionId);
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        
        // Return session data with QR code (if available)
        const sessionData = {
            id: session.id,
            qrCode: session.qr,
            phoneNumber: session.phone_number,
            isReady: session.ready,
            createdAt: session.created_at,
            updatedAt: session.updated_at
        };
        
        res.json({
            success: true,
            data: sessionData
        });
        
    } catch (error) {
        console.error('Error getting session:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Endpoint to sync history for all ready sessions
// app.post('/sync-all-sessions', async (req, res) => {
//     try {
//         console.log('🔄 Starting history sync for all ready sessions...');
//
//         // Check if current socket is available
//         if (!currentSocket) {
//             return res.status(400).json({
//                 success: false,
//                 message: 'WhatsApp connection not available'
//             });
//         }
//
//         // Get all ready sessions from database
//         const [sessions] = await database.pool.execute(
//             'SELECT * FROM sessions WHERE ready = 1'
//         );
//
//         if (sessions.length === 0) {
//             return res.json({
//                 success: true,
//                 message: 'No ready sessions found',
//                 syncedSessions: 0,
//                 totalMessages: 0
//             });
//         }
//
//         let totalSyncedMessages = 0;
//         const syncResults = [];
//
//         for (const session of sessions) {
//             try {
//                 console.log(`📱 Syncing session ${session.id} (${session.phone_number})...`);
//
//                 // Get chats from WhatsApp socket (using same method as getChatCounts)
//                 const chats = currentSocket.store?.chats || {};
//                 const chatArray = Object.values(chats);
//
//                 console.log(`   🔍 DEBUG: Found ${chatArray.length} chats in WhatsApp store`);
//                 console.log(`   🔍 DEBUG: Socket store exists: ${!!currentSocket.store}`);
//                 console.log(`   🔍 DEBUG: Chats object:`, Object.keys(chats));
//
//                 // Alternative: Try to get chats using the same method as getChatCounts
//                 if (chatArray.length === 0) {
//                     console.log(`   🔍 DEBUG: No chats found in store, trying alternative method...`);
//                     try {
//                         const allChats = await currentSocket.store?.chats || {};
//                         const allChatArray = Object.values(allChats);
//                         console.log(`   🔍 DEBUG: Alternative method found ${allChatArray.length} chats`);
//                     } catch (error) {
//                         console.log(`   🔍 DEBUG: Alternative method failed:`, error.message);
//                     }
//                 }
//
//                 let sessionMessageCount = 0;
//
//                 // Store chats in database using existing method
//                 for (const chat of chatArray) {
//                     try {
//                         await storeChatInDatabase(chat, currentSocket);
//                         console.log(`   📬 Chat stored: ${chat.name || chat.id}`);
//                     } catch (error) {
//                         console.error(`   ❌ Error storing chat ${chat.id}:`, error);
//                     }
//                 }
//
//                 // Get messages from WhatsApp socket
//                 const messages = currentSocket.store?.messages || {};
//                 console.log(`   🔍 DEBUG: Messages object keys:`, Object.keys(messages));
//
//                 // Store messages in database using existing method
//                 for (const chatId in messages) {
//                     const chatMessages = Object.values(messages[chatId]);
//                     console.log(`   🔍 DEBUG: Chat ${chatId} has ${chatMessages.length} messages`);
//
//                     for (const message of chatMessages) {
//                         try {
//                             await storeMessageInDatabase(message, currentSocket);
//                             sessionMessageCount++;
//                         } catch (error) {
//                             console.error(`   ❌ Error storing message ${message.key.id}:`, error);
//                         }
//                     }
//                 }
//
//                 totalSyncedMessages += sessionMessageCount;
//                 syncResults.push({
//                     sessionId: session.id,
//                     phoneNumber: session.phone_number,
//                     chatCount: chatArray.length,
//                     messageCount: sessionMessageCount
//                 });
//
//                 console.log(`✅ Session ${session.id} synced: ${chatArray.length} chats, ${sessionMessageCount} messages`);
//
//             } catch (error) {
//                 console.error(`❌ Error syncing session ${session.id}:`, error);
//                 syncResults.push({
//                     sessionId: session.id,
//                     phoneNumber: session.phone_number,
//                     error: error.message
//                 });
//             }
//         }
//
//         console.log(`🎉 History sync completed for ${sessions.length} sessions. Total messages: ${totalSyncedMessages}`);
//
//         res.json({
//             success: true,
//             message: 'History sync completed for all ready sessions',
//             syncedSessions: sessions.length,
//             totalMessages: totalSyncedMessages,
//             results: syncResults
//         });
//
//     } catch (error) {
//         console.error('Error syncing all sessions:', error);
//         res.status(500).json({
//             success: false,
//             message: 'Internal server error',
//             error: error.message
//         });
//     }
// });
//
// // Endpoint to get and print current QR code
// app.get('/session/:id/qr', async (req, res) => {
//     try {
//         const sessionId = req.params.id;
//
//         console.log(`🔍 Getting QR code for session ${sessionId}`);
//
//         // Get session data from database
//         const session = await database.getSession(sessionId);
//
//         console.log(`🔍 Session data from database:`, {
//             id: session?.id,
//             qr: session?.qr ? `Present (${session.qr.length} chars)` : 'Empty',
//             qrFull: session?.qr || 'null',
//             ready: session?.ready,
//             phoneNumber: session?.phone_number
//         });
//
//         if (!session) {
//             return res.status(404).json({
//                 success: false,
//                 message: 'Session not found'
//             });
//         }
//
//         if (!session.qr || session.qr === '') {
//             return res.json({
//                 success: false,
//                 message: 'No QR code available yet. Please wait for QR code generation.',
//                 sessionId: sessionId,
//                 debug: {
//                     qrExists: !!session.qr,
//                     qrLength: session.qr ? session.qr.length : 0,
//                     qrValue: session.qr
//                 }
//             });
//         }
//
//         // Print QR code to terminal
//         console.log(`\n🔄 Printing QR code for session ${sessionId}:`);
//         const qrDataForTerminal = session.qr.includes('data:image') ?
//             session.qr.split(',')[1] : session.qr; // Extract base64 part if it's a data URL
//         printQRCode(qrDataForTerminal);
//
//         res.json({
//             success: true,
//             message: 'QR code printed to terminal',
//             sessionId: sessionId,
//             qrCode: session.qr,
//             debug: {
//                 qrLength: session.qr.length,
//                 qrType: session.qr.includes('data:image') ? 'data_url' : 'base64_string',
//                 qrFull: session.qr
//             }
//         });
//
//     } catch (error) {
//         console.error('Error getting QR code:', error);
//         res.status(500).json({
//             success: false,
//             message: 'Internal server error',
//             error: error.message
//         });
//     }
// });
//
// // Endpoint to display QR code in web browser
// app.get('/session/:id/qr-image', async (req, res) => {
//     try {
//         const sessionId = req.params.id;
//
//         console.log(`🔍 Getting QR code image for session ${sessionId}`);
//
//         // Get session data from database
//         const session = await database.getSession(sessionId);
//
//         console.log(`🔍 Session data for QR image:`, {
//             id: session?.id,
//             qr: session?.qr ? `Present (${session.qr.length} chars)` : 'Empty',
//             qrFull: session?.qr || 'null'
//         });
//
//         if (!session) {
//             return res.status(404).send('Session not found');
//         }
//
//         if (!session.qr || session.qr === '') {
//             return res.status(404).send('No QR code available yet. Please wait for QR code generation.');
//         }
//
//         // Check if QR code is a data URL (base64 image)
//         if (session.qr.includes('data:image')) {
//             console.log(`🔍 Processing data URL QR code`);
//             // Extract base64 data and set appropriate headers
//             const base64Data = session.qr.split(',')[1];
//             console.log(`🔍 Extracted base64 data length: ${base64Data.length}`);
//
//             const buffer = Buffer.from(base64Data, 'base64');
//             console.log(`🔍 Buffer size: ${buffer.length} bytes`);
//
//             res.set({
//                 'Content-Type': 'image/png',
//                 'Content-Length': buffer.length,
//                 'Cache-Control': 'no-cache'
//             });
//
//             res.send(buffer);
//         } else {
//             console.log(`🔍 Processing raw base64 QR code`);
//             // If it's not a data URL, return the raw base64 data
//             const buffer = Buffer.from(session.qr, 'base64');
//             console.log(`🔍 Buffer size: ${buffer.length} bytes`);
//
//             res.set({
//                 'Content-Type': 'image/png',
//                 'Content-Length': buffer.length,
//                 'Cache-Control': 'no-cache'
//             });
//
//             res.send(buffer);
//         }
//
//     } catch (error) {
//         console.error('Error getting QR code image:', error);
//         res.status(500).send('Internal server error');
//     }
// });

// Endpoint to list all saved QR code images
app.get('/qrs', (req, res) => {
    try {
        const qrsDir = path.join(__dirname, 'qrs');
        
        // Check if qrs directory exists
        if (!fs.existsSync(qrsDir)) {
            return res.json({
                success: true,
                message: 'No QR codes saved yet',
                qrCodes: []
            });
        }
        
        // Read all files in qrs directory
        const files = fs.readdirSync(qrsDir);
        const qrFiles = files
            .filter(file => file.endsWith('.png'))
            .map(file => {
                const filepath = path.join(qrsDir, file);
                const stats = fs.statSync(filepath);
                return {
                    filename: file,
                    filepath: filepath,
                    size: stats.size,
                    created: stats.birthtime,
                    modified: stats.mtime
                };
            })
            .sort((a, b) => b.created - a.created); // Sort by newest first
        
        res.json({
            success: true,
            message: `Found ${qrFiles.length} QR code images`,
            qrCodes: qrFiles
        });
        
    } catch (error) {
        console.error('Error listing QR codes:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Endpoint to serve QR code image files
app.get('/qrs/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const qrsDir = path.join(__dirname, 'qrs');
        const filepath = path.join(qrsDir, filename);
        
        // Check if file exists
        if (!fs.existsSync(filepath)) {
            return res.status(404).send('QR code image not found');
        }
        
        // Check if it's a PNG file
        if (!filename.endsWith('.png')) {
            return res.status(400).send('Invalid file type. Only PNG files are allowed.');
        }
        
        // Read and send the file
        const buffer = fs.readFileSync(filepath);
        
        res.set({
            'Content-Type': 'image/png',
            'Content-Length': buffer.length,
            'Cache-Control': 'no-cache'
        });
        
        res.send(buffer);
        
    } catch (error) {
        console.error('Error serving QR code image:', error);
        res.status(500).send('Internal server error');
    }
});

// Test endpoint to manually update QR code (for debugging)
app.post('/session/:id/update-qr', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const { qrCode } = req.body;
        
        if (!qrCode) {
            return res.status(400).json({
                success: false,
                message: 'QR code is required in request body'
            });
        }
        
        console.log(`🔄 Manually updating QR code for session ${sessionId}`);
        await sessionManager.updateSessionQR(sessionId, qrCode);
        
        // Verify the update
        const updatedSession = await database.getSession(sessionId);
        
        res.json({
            success: true,
            message: 'QR code updated successfully',
            sessionId: sessionId,
            qrCodeInDB: updatedSession.qr ? 'Present (' + updatedSession.qr.length + ' chars)' : 'Empty'
        });
        
    } catch (error) {
        console.error('Error updating QR code:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Endpoint to manually trigger history sync for a session
app.post('/session/:sessionId/sync-history', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { daysBack } = req.body; // Optional: how many days of history to sync

        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔄 MANUAL HISTORY SYNC TRIGGERED for session ${sessionId}`);
        console.log(`${'='.repeat(60)}`);

        // Get session data
        const session = await database.getSession(sessionId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }

        if (!session.ready) {
            return res.status(400).json({
                success: false,
                message: 'Session is not ready. Please scan QR code first.'
            });
        }

        // Get socket for this session
        const sock = sessionSockets.get(parseInt(sessionId));
        if (!sock) {
            return res.status(400).json({
                success: false,
                message: 'Session socket not connected. Try restoring the session first.'
            });
        }

        // Request history sync from WhatsApp
        console.log('📡 Requesting history sync from WhatsApp...');

        // The history sync happens automatically through messaging-history.set event
        // We can trigger a reconnection to force a fresh sync
        try {
            // Get current chats from store
            const chats = sock.store?.chats ? Object.values(sock.store.chats) : [];
            const contacts = sock.store?.contacts ? Object.values(sock.store.contacts) : [];

            console.log(`📊 Current store state: ${chats.length} chats, ${contacts.length} contacts`);

            // Fetch messages for each chat
            let totalMessagesSynced = 0;
            let totalChatsSynced = 0;

            for (const chat of chats) {
                try {
                    // Store chat in database
                    await storeChatInDatabase(chat, sock, sessionId);
                    totalChatsSynced++;

                    // Try to fetch messages for this chat
                    // Note: This may not work for all message types depending on WhatsApp's sync state
                    const messages = sock.store?.messages?.[chat.id];
                    if (messages) {
                        const messageArray = Object.values(messages);
                        console.log(`📨 Found ${messageArray.length} messages in ${chat.id}`);

                        for (const message of messageArray) {
                            try {
                                // Check if message exists
                                const existingMessage = await database.getMessage(message.key?.id);
                                if (!existingMessage) {
                                    await storeHistorySyncMessage(message, sock, sessionId, contacts);
                                    totalMessagesSynced++;
                                }
                            } catch (msgError) {
                                console.error(`❌ Error syncing message:`, msgError.message);
                            }
                        }
                    }
                } catch (chatError) {
                    console.error(`❌ Error syncing chat ${chat.id}:`, chatError.message);
                }
            }

            console.log(`\n${'='.repeat(60)}`);
            console.log(`✅ MANUAL HISTORY SYNC COMPLETED`);
            console.log(`📂 Chats synced: ${totalChatsSynced}`);
            console.log(`📨 Messages synced: ${totalMessagesSynced}`);
            console.log(`${'='.repeat(60)}\n`);

            res.json({
                success: true,
                message: 'History sync completed',
                sessionId: sessionId,
                stats: {
                    chatsSynced: totalChatsSynced,
                    messagesSynced: totalMessagesSynced
                }
            });

        } catch (syncError) {
            console.error('❌ Error during history sync:', syncError);
            res.status(500).json({
                success: false,
                message: 'Error during history sync',
                error: syncError.message
            });
        }

    } catch (error) {
        console.error('Error triggering history sync:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Endpoint to manually restore all ready sessions
app.post('/restore-sessions', async (req, res) => {
    try {
        console.log('🔄 Manual session restoration triggered');
        
        await restoreAllReadySessions();
        
        res.json({
            success: true,
            message: 'All ready sessions restoration completed',
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error in manual session restoration:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to restore sessions',
            error: error.message
        });
    }
});

// Endpoint to get all ready sessions status
app.get('/sessions/status', async (req, res) => {
    try {
        const readySessions = await database.getAllReadySessions();
        
        const sessionStatus = readySessions.map(session => ({
            id: session.id,
            phoneNumber: session.phone_number,
            // isConnected: sessionSockets.has(session.id),
            createdAt: session.created_at,
            updatedAt: session.updated_at
        }));
        
        res.json({
            success: true,
            totalSessions: readySessions.length,
            connectedSessions: sessionStatus.filter(s => s.isConnected).length,
            sessions: sessionStatus
        });
        
    } catch (error) {
        console.error('Error getting sessions status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get sessions status',
            error: error.message
        });
    }
});

// Endpoint to convert raw QR data to proper QR code image
app.post('/convert-qr', async (req, res) => {
    try {
        // const { rawQRData } = req.body;
        let rawQRData ='2@PSZ42LR4Ap/yRLdwqA4E2ef/ns7fXUsauCiTWLXFE1Ke4NSbk7HtA/2N9iQkHLk3jZrXc8JpvyCrrgAXONpOvECAOEFpxqsxHUQ=,A6STEjJNTzhZ5yg4TTZ5cnDepKUtwkAbjPSzZNjxJHU=,E5tSe8rrGBXg2GSDexkfWte2L4OcMia1EHMPKc0r50c=,3OgV9Gzjq+mljWPxgJE16snRS4PJ6NfW5kSqXagRmzA=';

        
        if (!rawQRData) {
            return res.status(400).json({
                success: false,
                message: 'Raw QR data is required in request body'
            });
        }
        
        console.log(`🔄 Converting raw QR data to image...`);
        const qrImageBase64 = await convertRawQRToImage(rawQRData);
        
        if (!qrImageBase64) {
            return res.status(500).json({
                success: false,
                message: 'Failed to convert QR data to image'
            });
        }
        
        res.json({
            success: true,
            message: 'QR code converted successfully',
            qrImage: qrImageBase64,
            qrImageLength: qrImageBase64.length
        });
        
    } catch (error) {
        console.error('Error converting QR code:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Debug endpoint to check database QR code storage
app.get('/debug/session/:id/qr', async (req, res) => {
    try {
        const sessionId = req.params.id;
        
        console.log(`🔍 DEBUG: Checking QR code for session ${sessionId}`);
        
        // Get session data from database
        const session = await database.getSession(sessionId);
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                sessionId: sessionId
            });
        }
        
        // Return detailed debug information
        res.json({
            success: true,
            sessionId: sessionId,
            sessionData: {
                id: session.id,
                qr: session.qr,
                qrLength: session.qr ? session.qr.length : 0,
                qrType: session.qr ? (session.qr.includes('data:image') ? 'data_url' : 'base64_string') : 'null',
                qrFull: session.qr || 'null',
                ready: session.ready,
                phoneNumber: session.phone_number,
                createdAt: session.created_at,
                updatedAt: session.updated_at
            },
            debug: {
                qrExists: !!session.qr,
                qrNotEmpty: session.qr && session.qr !== '',
                qrIsDataUrl: session.qr && session.qr.includes('data:image'),
                qrIsBase64: session.qr && !session.qr.includes('data:image') && session.qr.length > 0
            }
        });
        
    } catch (error) {
        console.error('Error in debug endpoint:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Endpoint to search for chat by phone number (handles @lid and regular accounts)
app.get('/session/:sessionId/chat/search', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { phone } = req.query;

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required (use ?phone=XXXXXXXXXX)'
            });
        }

        console.log(`🔍 Searching for chat with phone: ${phone} in session ${sessionId}`);

        // Use the phoneResolver utility to find the chat
        const chat = await phoneResolver.findChatByPhone(database, phone, sessionId);

        if (!chat) {
            return res.status(404).json({
                success: false,
                message: 'Chat not found for this phone number',
                searchedPhone: phone
            });
        }

        res.json({
            success: true,
            message: 'Chat found',
            chat: {
                id: chat.id,
                sessionId: chat.session_id,
                name: chat.name,
                phoneNumber: chat.phone_number,
                isGroup: chat.is_group,
                lastMessageTimestamp: chat.last_message_timestamp,
                isBusinessAccount: phoneResolver.isBusinessAccount(chat.id),
                isRegularAccount: phoneResolver.isRegularAccount(chat.id)
            }
        });

    } catch (error) {
        console.error('Error searching chat by phone:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Endpoint to send message by phone number (auto-resolves @lid)
app.post('/session/:sessionId/send-by-phone', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { phone, text } = req.body;

        if (!phone || !text) {
            return res.status(400).json({
                success: false,
                message: 'Phone number and text are required'
            });
        }

        // Get socket for this session
        const sock = sessionSockets.get(parseInt(sessionId));
        if (!sock) {
            return res.status(404).json({
                success: false,
                message: 'Session not found or not connected'
            });
        }

        console.log(`📤 Sending message to phone ${phone} in session ${sessionId}`);

        // Convert phone to proper JID (handles @lid resolution)
        const jid = await phoneResolver.phoneToJid(sock, phone);
        console.log(`✅ Resolved phone ${phone} to JID: ${jid}`);

        // Send the message
        const result = await sock.sendMessage(jid, { text });

        res.json({
            success: true,
            message: 'Message sent successfully',
            sentTo: {
                phone,
                jid,
                isBusinessAccount: phoneResolver.isBusinessAccount(jid),
                isRegularAccount: phoneResolver.isRegularAccount(jid)
            },
            messageId: result?.key?.id
        });

    } catch (error) {
        console.error('Error sending message by phone:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send message',
            error: error.message
        });
    }
});

// Endpoint to resolve phone number to JID (useful for testing)
app.get('/session/:sessionId/resolve-phone', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { phone } = req.query;

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required (use ?phone=XXXXXXXXXX)'
            });
        }

        // Get socket for this session
        const sock = sessionSockets.get(parseInt(sessionId));
        if (!sock) {
            return res.status(404).json({
                success: false,
                message: 'Session not found or not connected'
            });
        }

        console.log(`🔄 Resolving phone ${phone} to JID in session ${sessionId}`);

        // Resolve phone to JID
        const jid = await phoneResolver.phoneToJid(sock, phone);

        res.json({
            success: true,
            phone,
            jid,
            accountType: phoneResolver.isBusinessAccount(jid) ? 'Business (@lid)' :
                        phoneResolver.isRegularAccount(jid) ? 'Regular (@s.whatsapp.net)' :
                        'Unknown'
        });

    } catch (error) {
        console.error('Error resolving phone:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to resolve phone number',
            error: error.message
        });
    }
});

// Function to clear sync state files to force fresh history sync
// This mimics what happens when you close and reopen WhatsApp Web browser
function clearSyncState(authDir) {
    try {
        if (!fs.existsSync(authDir)) {
            return;
        }

        const files = fs.readdirSync(authDir);
        let cleared = 0;

        for (const file of files) {
            // Delete app-state-sync files (these track what data has been synced)
            // Keep: creds.json, pre-key-*.json, sender-key-*.json, session-*.json
            if (file.startsWith('app-state-sync-')) {
                const filePath = path.join(authDir, file);
                fs.unlinkSync(filePath);
                cleared++;
            }
        }

        if (cleared > 0) {
            console.log(`🔄 Cleared ${cleared} sync state files to force fresh history sync`);
        }
    } catch (error) {
        console.log(`⚠️ Could not clear sync state: ${error.message}`);
    }
}

// Function to start WhatsApp for a specific session
async function startWhatsAppForSession(sessionId, forceHistorySync = false) {
    console.log(`🚀 Starting WhatsApp connection for session: ${sessionId}`);

    // Use multi-file auth state for persistent sessions (session-specific)
    const authDir = `auth_info_baileys_${sessionId}`;

    // Ensure the auth directory exists before using it
    try {
        if (!fs.existsSync(authDir)) {
            console.log(`📁 Creating auth directory: ${authDir}`);
            fs.mkdirSync(authDir, { recursive: true });
            console.log(`✅ Auth directory created: ${authDir}`);
        }
    } catch (error) {
        console.error(`❌ Error creating auth directory ${authDir}:`, error);
        throw new Error(`Failed to create auth directory: ${error.message}`);
    }

    // Clear sync state to force WhatsApp to send history (like closing/reopening browser)
    if (forceHistorySync) {
        clearSyncState(authDir);
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // Don't print QR in terminal for multiple sessions
        defaultQueryTimeoutMs: 60000,
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        // CRITICAL: Prevent automatic logout on connection issues
        connectTimeoutMs: 120000, // 2 minutes timeout instead of default
        keepAliveIntervalMs: 30000, // Send keep-alive every 30 seconds to prevent idle timeout
        retryRequestDelayMs: 6000, // Increase retry delay
        reconnectDelayStart: 500,
        reconnectDelayMax: 20000,
        maxRetries: 10, // Increase retry attempts
        getMessage: async (key) => {
            // Message lookup for retry purposes
            return undefined;
        }
    });

    // Store socket for this session
    sessionSockets.set(sessionId, sock);
    // fs.writeFileSync('011_.json', sock ? JSON.stringify(sessionId):JSON.stringify(0) );
    // fs.writeFileSync('010_.json', JSON.stringify(sessionSockets));
    
    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);
    
    // Connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`📱 QR code generated for session ${sessionId}`);
            
            // Convert QR string to base64 image using qrcode library
            try {
                const qrImageBase64 = await QRCode.toDataURL(qr, {
                    type: 'image/png',
                    quality: 0.92,
                    margin: 1,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    },
                    width: 256
                });
                
                // Print QR code to terminal
                printQRCode(qr);
                
                // Update session in database with new QR code
                await database.updateSessionQR(sessionId, qrImageBase64);
                console.log(`✅ QR code image updated in database for session ${sessionId}`);
            } catch (error) {
                console.error(`❌ Error converting/storing QR code for session ${sessionId}:`, error.message);
                // Fallback: store raw QR data
                await database.updateSessionQR(sessionId, qr);
            }
        }
        
        if (connection === 'open') {
            console.log(`✅ WhatsApp connection opened successfully for session ${sessionId}!`);

            // Update session in database: set ready = true, store phone number, clear QR code
            try {
                const phoneNumber = sock.user?.id?.split(':')[0] || 'unknown';

                // Check if this phone number already exists in sessions table
                const existingSession = await database.getSessionByPhoneNumber(phoneNumber);

                if (existingSession && existingSession.id !== sessionId) {
                    console.log(`⚠️ Phone number ${phoneNumber} already exists in session ${existingSession.id}`);
                    console.log(`🔄 Migrating data from old session ${existingSession.id} to new session ${sessionId}`);

                    // Migrate all chats and messages from old session to new session
                    const migrationResult = await database.migrateSessionData(existingSession.id, sessionId);

                    console.log(`✅ Migration completed: ${migrationResult.migratedChats} chats, ${migrationResult.migratedMessages} messages`);
                }

                // Update the new session as ready
                await database.updateSessionReady(sessionId, phoneNumber);
                console.log(`📱 Session ${sessionId} ready for phone: ${phoneNumber}`);
                
                // Verify saved data in database
                console.log(`\n${'='.repeat(60)}`);
                console.log(`📚 DATA PERSISTENCE CHECK`);
                console.log(`${'='.repeat(60)}`);
                
                try {
                    // Get all chats for this session
                    const [chats] = await database.pool.execute(
                        'SELECT COUNT(*) as count FROM chats WHERE session_id = ?',
                        [sessionId]
                    );
                    const chatCount = chats[0].count;
                    
                    // Get all messages for this session
                    const [messages] = await database.pool.execute(
                        'SELECT COUNT(*) as count FROM messages WHERE session_id = ?',
                        [sessionId]
                    );
                    const messageCount = messages[0].count;
                    
                    console.log(`✅ Saved data for session ${sessionId}:`);
                    console.log(`   📂 Chats: ${chatCount}`);
                    console.log(`   📨 Messages: ${messageCount}`);
                    console.log(`   💾 Data is persisted and will be recovered if you logout and login again`);
                    console.log(`${'='.repeat(60)}\n`);
                } catch (error) {
                    console.log(`⚠️ Could not verify saved data: ${error.message}`);
                }

                // Sync any missed messages that arrived while server was down
                console.log(`\n📬 Checking for missed messages...`);
                await syncMissedMessages(sock, sessionId);
                
                // Set up message listeners for this session
                setupMessageListeners(sock, sessionId);
                
            } catch (error) {
                console.error(`❌ Error marking session ${sessionId} as ready:`, error.message);
            }
        }
        
        if (connection === 'close') {
            console.log(`❌ Connection closed for session ${sessionId}`);
            
            // DO NOT mark session as not ready - keep session ready to enable reconnection
            // This prevents the "session not ready" error when reconnecting
            
            // Check the disconnect reason
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                console.log(`🚫 Session ${sessionId} logged out - not attempting reconnection`);
                
                // CLEANUP: Stop keep-alive interval and remove socket from map
                if (sock.keepAliveInterval) {
                    clearInterval(sock.keepAliveInterval);
                    console.log(`🛑 Stopped keep-alive interval for session ${sessionId}`);
                }
                sessionSockets.delete(sessionId);
                console.log(`🗑️ Removed socket for session ${sessionId} from active connections`);
                
                // Mark session as not ready in database
                try {
                    await database.pool.execute(
                        'UPDATE sessions SET ready = 0, updated_at = NOW() WHERE id = ?',
                        [sessionId]
                    );
                    console.log(`✅ Session ${sessionId} marked as not ready in database`);
                } catch (error) {
                    console.error(`❌ Error updating session status for ${sessionId}:`, error.message);
                }
                return;
            }
            
            // For all other errors (network issues, temporary disconnects), attempt reconnection WITHOUT marking ready=0
            if (shouldReconnect) {
                console.log(`🔄 Connection lost for session ${sessionId} - attempting to reconnect in 3 seconds...`);
                console.log(`📌 Session remains ready in database to maintain connection state`);
                setTimeout(() => {
                    startWhatsAppForSession(sessionId);
                }, 3000);
            }
        }
    });

    // KEEP-ALIVE MECHANISM: Prevent idle timeout and verify connection status
    // Uses actual API call (fetchPrivacySettings) to test connection
    // IMPORTANT: Does NOT mark ready=0 on failures - only actual logout events should do that
    const keepAliveInterval = setInterval(async () => {
        try {
            // Check if session still exists in database
            const session = await database.getSession(sessionId);

            if (!session) {
                console.log(`⚠️ Session ${sessionId} not found in database - stopping keep-alive`);
                clearInterval(keepAliveInterval);
                sessionSockets.delete(sessionId);
                return;
            }

            // Test actual connection by making an API call (not just checking WebSocket state)
            // This is more reliable than sock.ws?.readyState === 1 which can fail on brief network hiccups
            try {
                await sock.fetchPrivacySettings();
                console.log(`💚 Keep-alive ping for session ${sessionId} - Connection OK`);

                // Ensure session is marked as ready in database (only mark ready, never unmark here)
                if (!session.ready) {
                    const phoneNumber = sock.user?.id?.split(':')[0] || session.phone_number;
                    await database.markSessionReady(sessionId, phoneNumber);
                    console.log(`✅ Session ${sessionId} marked as ready (connection verified)`);
                }
            } catch (apiError) {
                // Connection test failed - log but do NOT mark ready=0
                // Only actual logout events (in connection.update handler) should mark ready=0
                console.log(`⚠️ Session ${sessionId} keep-alive failed: ${apiError.message}`);
                console.log(`⏳ Session ${sessionId} remains ready - waiting for actual logout event`);

                // Try to reconnect silently without changing ready status
                try {
                    clearInterval(keepAliveInterval);
                    await startWhatsAppForSession(sessionId);
                } catch (reconnectError) {
                    console.log(`⚠️ Reconnect attempt for session ${sessionId}: ${reconnectError.message}`);
                }
            }
        } catch (error) {
            console.log(`⚠️ Keep-alive error for session ${sessionId}: ${error.message}`);
        }
    }, 30000); // Every 30 seconds

    // Store interval ID for cleanup if needed
    sock.keepAliveInterval = keepAliveInterval;

    // Listen for messages (both real-time and history/offline)
    sock.ev.on('messages.upsert', async (messageUpdate) => {
        const { messages, type } = messageUpdate;

        // Handle both 'notify' (real-time) and 'append' (history/offline) messages
        if (type === 'notify' || type === 'append') {
            if (type === 'append') {
                console.log(`📥 Received ${messages.length} offline/history messages`);
            }

            for (const message of messages) {
                // fs.writeFileSync('0.json', JSON.stringify(message));
                // First, ensure the chat exists in database
                try {
                    await ensureChatExists(message, sock, sessionId);
                } catch (error) {
                    console.error(`❌ Error ensuring chat exists:`, error);
                }

                // Store message in database (both incoming and outgoing)
                try {
                    await storeMessageInDatabase(message, sock, sessionId);
                } catch (error) {
                    console.error(`❌ Error storing message ${message.key.id}:`, error);
                }
            }

            if (type === 'append') {
                console.log(`✅ Stored ${messages.length} offline/history messages`);
            }
        }
    });

    // Listen for messaging history sync
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, syncType }) => {
        return;
        console.log(`\n${'='.repeat(60)}`);
        console.log(`⚡ HISTORY SYNC EVENT for session ${sessionId}`);
        console.log(`${'='.repeat(60)}`);
        console.log(`📊 Sync Type: ${syncType}`);
        console.log(`💬 Chats received: ${chats?.length || 0}`);
        console.log(`👥 Contacts received: ${contacts?.length || 0}`);
        console.log(`📨 Messages received: ${messages?.length || 0}`);

        // Get the latest message timestamp from database to sync only new messages
        // This allows syncing messages that arrived while the server was down
        let syncFromDate = 0;
        try {
            const [latestMsg] = await database.pool.execute(
                'SELECT MAX(timestamp) as latest FROM messages WHERE session_id = ?',
                [sessionId]
            );
            syncFromDate = latestMsg[0]?.latest || 0;
            console.log(`📅 Syncing messages newer than: ${syncFromDate ? new Date(syncFromDate * 1000).toLocaleString() : 'all messages (first sync)'}`);
        } catch (err) {
            console.log(`⚠️ Could not get latest message timestamp, will sync all messages`);
        }
        console.log(`${'='.repeat(60)}\n`);

        // Process history sync in background to avoid blocking
        setImmediate(async () => {
            try {
                let storedChats = 0;
                let storedMessages = 0;
                let skippedMessages = 0;
                let skippedOldMessages = 0;

                // Build a contacts map for faster lookup (id -> contact object)
                const contactsMap = new Map();
                for (const contact of (contacts || [])) {
                    if (contact.id) {
                        contactsMap.set(contact.id, contact);
                    }
                }
                console.log(`📇 Built contacts map with ${contactsMap.size} entries`);

                // Store synced chats in database with contact names
                console.log(`📂 Processing ${chats?.length || 0} chats...`);
                for (const chat of (chats || [])) {
                    try {
                        // Enrich chat with contact name if available
                        const isGroup = chat.id.endsWith('@g.us');
                        if (!isGroup && !chat.name && !chat.notify) {
                            // Try to get name from contacts map
                            const contact = contactsMap.get(chat.id);
                            if (contact) {
                                if (contact.name) {
                                    chat.name = contact.name;
                                } else if (contact.notify) {
                                    chat.notify = contact.notify;
                                } else if (contact.verifiedName) {
                                    chat.verifiedName = contact.verifiedName;
                                }
                            }
                        }
                        await storeChatInDatabase(chat, sock, sessionId);
                        storedChats++;
                    } catch (error) {
                        console.error(`❌ Error storing synced chat ${chat.id}:`, error.message);
                    }
                }
                console.log(`✅ Stored ${storedChats} chats`);

                // Store synced messages in database
                console.log(`📨 Processing ${messages?.length || 0} messages...`);

                // Process messages in batches to avoid overwhelming the database
                const batchSize = 50;
                const messageArray = messages || [];

                // Convert contacts array to the format expected by storeHistorySyncMessage
                const contactsArray = Array.from(contactsMap.values());

                for (let i = 0; i < messageArray.length; i += batchSize) {
                    const batch = messageArray.slice(i, i + batchSize);

                    for (const message of batch) {
                        try {
                            // Skip messages older than sync date
                            const messageTimestamp = Number(message.messageTimestamp) || 0;
                            if (messageTimestamp < syncFromDate) {
                                skippedOldMessages++;
                                continue;
                            }

                            // Check if message already exists in database to avoid duplicates
                            const existingMessage = await database.getMessage(message.key?.id);
                            if (existingMessage) {
                                skippedMessages++;
                                continue;
                            }

                            // Ensure chat exists before storing message
                            await ensureChatExists(message, sock, sessionId);

                            // Store message with history sync context (pass contacts array)
                            await storeHistorySyncMessage(message, sock, sessionId, contactsArray);
                            storedMessages++;
                        } catch (error) {
                            console.error(`❌ Error storing synced message ${message.key?.id}:`, error.message);
                        }
                    }

                    // Log progress for large syncs
                    if (messageArray.length > batchSize) {
                        const progress = Math.min(i + batchSize, messageArray.length);
                        console.log(`📊 Progress: ${progress}/${messageArray.length} messages processed`);
                    }
                }

                console.log(`\n${'='.repeat(60)}`);
                console.log(`✅ HISTORY SYNC COMPLETED for session ${sessionId}`);
                console.log(`📂 Chats stored: ${storedChats}`);
                console.log(`📨 Messages stored: ${storedMessages}`);
                console.log(`⏭️ Messages skipped (duplicates): ${skippedMessages}`);
                console.log(`🔙 Messages skipped (older than ${new Date(syncFromDate * 1000).toLocaleDateString()}): ${skippedOldMessages}`);
                console.log(`${'='.repeat(60)}\n`);
                console.log(`💾 All messages have been saved to database for persistence across logout/login`);

            } catch (error) {
                console.error(`❌ Error in history sync processing:`, error.message);
            }
        });
    });

    sock.ev.on('messages.update', async (messageUpdates) => {
        // messageStatusUpdateCount++;
        console.log('\n📊 Message Status Update:');
        // console.log(`🔍 DEBUG: Update #${messageStatusUpdateCount} - Total updates received:`, messageUpdates.length);
        // fs.writeFileSync('messageStatusUpdate.json', JSON.stringify(messageUpdates, null, 2));

        for (const update of messageUpdates) {
            const { key, update: statusUpdate } = update;
            const chatId = key.remoteJid;
            const messageId = key.id;
            const isGroup = chatId.endsWith('@g.us');
            const chatType = isGroup ? 'Group' : 'Individual';
            const chatNumber = chatId.split('@')[0];

            console.log(`   📱 ${chatType} Chat: ${chatNumber}`);
            console.log(`   📧 Message ID: ${messageId}`);

            // Check message status
            if (statusUpdate.status !== undefined) {
                const timestamp = new Date().toLocaleString();
                console.log('statusUpdate.status');
                console.log(statusUpdate.status);

                let statusText = '';
                switch (statusUpdate.status) {
                    case 0:
                        statusText = 'pending';
                        console.log(`   ⏳ Status: PENDING at ${timestamp}`);
                        break;
                    case 1:
                        statusText = 'sent';
                        console.log(`   📤 Status: SENT at ${timestamp}`);
                        break;
                    case 3:
                        statusText = 'delivered';
                        console.log(`   ✅ Status: DELIVERED at ${timestamp}`);
                        break;
                    case 4:
                        statusText = 'read';
                        console.log(`   👀 Status: READ at ${timestamp}`);
                        break;
                    default:
                        statusText = 'unknown';
                        console.log(`   ❓ Status: UNKNOWN (${statusUpdate.status}) at ${timestamp}`);
                }

                // Update message status in database
                try {
                    // Debug: Check if message exists in database before updating
                    setTimeout(() => {
                        const existingMessage = database.getMessage(messageId);
                        if (existingMessage) {
                            console.log(`🔍 DEBUG: Found message in database for ID ${messageId}, current status: ${existingMessage.status}`);
                            database.updateMessageStatus(messageId, statusText);
                            console.log(`✅ Message status updated in database: ${statusText} (ID: ${messageId})`);
                        } else {
                            console.log(`⚠️ DEBUG: Message ID ${messageId} not found in database - cannot update status`);
                            console.log(`🔍 DEBUG: This might be why status updates aren't working for outgoing messages`);
                        }
                    }, 5000); // 5000 ms = 5 seconds
                } catch (error) {
                    console.error(`❌ Error updating message status for ID ${messageId}:`, error);
                }
            }

            // For group messages, show read receipts from individual participants
            if (statusUpdate.userReceipt && statusUpdate.userReceipt.length > 0) {
                console.log(`   📋 Read Receipts:`);
                statusUpdate.userReceipt.forEach(receipt => {
                    const userNumber = receipt.userJid.split('@')[0];
                    const receiptTime = new Date(receipt.receiptTimestamp * 1000).toLocaleString();
                    const receiptStatus = receipt.receiptType === 1 ? 'READ' : 'DELIVERED';
                    console.log(`     👤 ${userNumber}: ${receiptStatus} at ${receiptTime}`);
                });
            }

            console.log('   ─────────────────────────────');
        }
    });


    // sock.ev.on('message-receipt.update', async (updates) => {
    //     console.log('\n📬 Message Receipt Update:');
    //     fs.writeFileSync('messageReceipt.json', JSON.stringify(updates, null, 2));
    //
    //     for (const update of updates) {
    //         const { key, receipt } = update;
    //         const chatId = key.remoteJid;
    //         const messageId = key.id;
    //         const isGroup = chatId.endsWith('@g.us');
    //         const chatType = isGroup ? 'Group' : 'Individual';
    //
    //         // Extract numbers
    //         let chatNumber = chatId.split('@')[0];
    //         let participantNumber = 'N/A';
    //
    //         if (isGroup && key.participant) {
    //             participantNumber = key.participant.split('@')[0];
    //         }
    //
    //         console.log(`   📱 ${chatType} Chat: ${chatNumber}`);
    //         console.log(`   📧 Message ID: ${messageId}`);
    //
    //         if (isGroup) {
    //             console.log(`   👤 Participant: ${participantNumber}`);
    //
    //             // Get and display all group participants for context
    //             try {
    //                 const groupMetadata = await sock.groupMetadata(chatId);
    //                 const phoneNumbers = groupMetadata.participants.map(p =>
    //                     p.phoneNumber.replace('@s.whatsapp.net', '')
    //                 );
    //                 fs.writeFileSync('groupMetadata1.json', JSON.stringify(phoneNumbers));
    //                 if (groupMetadata && groupMetadata.participants) {
    //                     console.log(`   📋 All Group Participants (${groupMetadata.participants.length} members):`);
    //                     groupMetadata.participants.forEach((participant, index) => {
    //                         const pNumber = participant.id.split('@')[0];
    //                         const isAdmin = participant.admin ? ' (Admin)' : '';
    //                         const isSuperAdmin = participant.admin === 'superadmin' ? ' (Super Admin)' : '';
    //                         const adminStatus = isSuperAdmin || isAdmin;
    //
    //                         // Highlight the participant who triggered this receipt
    //                         const isReceiptParticipant = pNumber === participantNumber ? ' 👈 (Receipt from)' : '';
    //
    //                         console.log(`      ${index + 1}. ${pNumber}${adminStatus}${isReceiptParticipant}`);
    //                     });
    //                     console.log(`   ─────────────────────────────`);
    //                 }
    //             } catch (error) {
    //                 console.log(`   ❌ Could not fetch group participants: ${error.message}`);
    //             }
    //         }
    //
    //         // Parse receipt status
    //         if (receipt) {
    //             const timestamp = new Date(receipt.receiptTimestamp * 1000).toLocaleString();
    //             console.log('receipt.receiptType');
    //             console.log(receipt);
    //             // if(receipt.userJid !== '45102139449572@lid'){
    //             //     fs.writeFileSync('receipt.json',JSON.stringify(receipt, null, 2));
    //             // }
    //             switch (receipt.receiptType) {
    //                 case 0:
    //                     console.log(`   ✅ Status: DELIVERED at ${timestamp}`);
    //                     break;
    //                 case 1:
    //                     console.log(`   👀 Status: READ at ${timestamp}`);
    //                     break;
    //                 case 2:
    //                     console.log(`   📤 Status: SENT at ${timestamp}`);
    //                     break;
    //                 default:
    //                     console.log(`   ❓ Status: UNKNOWN (${receipt.receiptType}) at ${timestamp}`);
    //             }
    //
    //             // Additional receipt info
    //             if (receipt.userJid) {
    //                 const userNumber = receipt.userJid.split('@')[0];
    //                 console.log(`   👥 User: ${userNumber}`);
    //             }
    //         }
    //
    //         console.log('   ─────────────────────────────');
    //     }
    // });
    
    return sock;
}

// Function to set up message listeners for a specific session
function setupMessageListeners(sock, sessionId) {
    console.log(`🔧 Setting up message listeners for session ${sessionId}`);
    
    // Listen for new chat events
    sock.ev.on('chats.upsert', async (chats) => {
        console.log(`\n🆕 New chat(s) detected for session ${sessionId}:`);
        
        for (const chat of chats) {
            const chatType = chat.id.endsWith('@g.us') ? 'Group' : 'Individual';
            const chatName = chat.name || chat.id.split('@')[0];
            console.log(`   📞 ${chatType} Chat: ${chatName} (${chat.id})`);
            
            // Store chat in database
            try {
                await storeChatInDatabase(chat, sock, sessionId);
            } catch (error) {
                console.error(`❌ Error storing chat ${chat.id}:`, error);
            }
        }
    });
}

// Function to sync missed messages from all chats after reconnection
async function syncMissedMessages(sock, sessionId) {
    try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📬 SYNCING MISSED MESSAGES for session ${sessionId}`);
        console.log(`${'='.repeat(60)}`);
        
        // Wait a moment for WhatsApp store to populate
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Get all chats from WhatsApp store
        const chats = sock.store?.chats ? Object.values(sock.store.chats) : [];
        console.log(`📂 Found ${chats.length} chats to sync messages from`);
        
        let totalMissedMessages = 0;
        
        for (const chat of chats) {
            try {
                // Get messages for this chat from WhatsApp store
                const messages = sock.store?.messages?.[chat.id] || {};
                const messageArray = Object.values(messages);
                
                if (messageArray.length === 0) continue;
                
                console.log(`\n📱 Chat: ${chat.name || chat.id} (${messageArray.length} messages)`);
                
                // Get the latest message timestamp from database for this chat
                const [latestDbMessage] = await database.pool.execute(
                    `SELECT MAX(timestamp) as lastTimestamp FROM messages 
                     WHERE chat_id = (SELECT id FROM chats WHERE phone_number = ? AND session_id = ?)`,
                    [chat.id.split('@')[0], sessionId]
                );
                
                const lastSyncTimestamp = latestDbMessage[0]?.lastTimestamp ? 
                    new Date(latestDbMessage[0].lastTimestamp).getTime() / 1000 : 0;
                
                console.log(`   📅 Last synced message timestamp: ${lastSyncTimestamp}`);
                
                // Filter messages newer than the last synced message
                const newMessages = messageArray.filter(msg => {
                    const msgTime = Number(msg.messageTimestamp) || 0;
                    return msgTime > lastSyncTimestamp;
                });
                
                if (newMessages.length > 0) {
                    console.log(`   ⭐ Found ${newMessages.length} new/missed messages to store`);
                    
                    // Store each missed message
                    for (const message of newMessages) {
                        try {
                            // Check if message already exists
                            const existingMsg = await database.getMessage(message.key?.id);
                            if (!existingMsg) {
                                await ensureChatExists(message, sock, sessionId);
                                await storeMessageInDatabase(message, sock, sessionId);
                                totalMissedMessages++;
                            }
                        } catch (error) {
                            console.error(`   ❌ Error storing message ${message.key?.id}:`, error.message);
                        }
                    }
                    
                    console.log(`   ✅ Stored ${newMessages.length} missed messages`);
                } else {
                    console.log(`   ✓ No new messages since last sync`);
                }
            } catch (error) {
                console.error(`❌ Error processing chat ${chat.id}:`, error.message);
            }
        }
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`✅ MISSED MESSAGE SYNC COMPLETED`);
        console.log(`   📬 Total new messages stored: ${totalMissedMessages}`);
        console.log(`${'='.repeat(60)}\n`);
        
        return totalMissedMessages;
        
    } catch (error) {
        console.error(`❌ Error during missed message sync:`, error.message);
        return 0;
    }
}

// Helper function to safely terminate a session and cleanup resources
async function terminateSession(sessionId) {
    try {
        console.log(`\n🛑 TERMINATING SESSION ${sessionId}`);
        console.log('='.repeat(60));
        
        // Get socket for this session
        const sock = sessionSockets.get(sessionId);
        
        if (sock) {
            // Stop keep-alive interval
            if (sock.keepAliveInterval) {
                clearInterval(sock.keepAliveInterval);
                console.log(`✅ Stopped keep-alive interval for session ${sessionId}`);
            }
            
            // Close WebSocket connection gracefully
            try {
                await sock.ws?.close();
                console.log(`✅ Closed WebSocket connection for session ${sessionId}`);
            } catch (error) {
                console.log(`⚠️ Error closing WebSocket: ${error.message}`);
            }
            
            // Remove socket from active connections map
            sessionSockets.delete(sessionId);
            console.log(`✅ Removed socket from active connections`);
        } else {
            console.log(`⚠️ Socket not found in active connections`);
        }
        
        // Update database to mark session as not ready
        try {
            await database.pool.execute(
                'UPDATE sessions SET ready = 0, updated_at = NOW() WHERE id = ?',
                [sessionId]
            );
            console.log(`✅ Marked session as not ready in database`);
        } catch (error) {
            console.error(`❌ Error updating database: ${error.message}`);
        }
        
        console.log('='.repeat(60));
        console.log(`✅ SESSION ${sessionId} TERMINATED AND CLEANED UP\n`);
        
    } catch (error) {
        console.error(`❌ Error terminating session ${sessionId}:`, error.message);
    }
}

async function startWhatsApp() {
    // Use multi-file auth state for persistent sessions
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    // Test database connection first
    try {
        console.log('🔍 Testing database connection...');
        await database.pool.execute('SELECT 1');
        console.log('✅ Database connection successful');
        
        // Load existing active session from database
        await sessionManager.loadActiveSession();
    } catch (error) {
        console.log('❌ Database connection failed:', error.message);
        console.log('💡 Bot will continue without database storage');
    }
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        defaultQueryTimeoutMs: 60000,
        syncFullHistory:true,
        shouldSyncHistoryMessage: () => true,
        syncSessionMessages :true,
        // CRITICAL: Prevent automatic logout on connection issues
        connectTimeoutMs: 120000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 6000,
        reconnectDelayStart: 500,
        reconnectDelayMax: 20000,
        maxRetries: 10
    });
    
    // Note: This function is deprecated - use startWhatsAppForSession for multi-session support

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.update', async (messageUpdates) => {
        messageStatusUpdateCount++;
        console.log('\n📊 Message Status Update:');
        console.log(`🔍 DEBUG: Update #${messageStatusUpdateCount} - Total updates received:`, messageUpdates.length);
        // fs.writeFileSync('messageStatusUpdate.json', JSON.stringify(messageUpdates, null, 2));

        for (const update of messageUpdates) {
            const { key, update: statusUpdate } = update;
            const chatId = key.remoteJid;
            const messageId = key.id;
            const isGroup = chatId.endsWith('@g.us');
            const chatType = isGroup ? 'Group' : 'Individual';
            const chatNumber = chatId.split('@')[0];

            console.log(`   📱 ${chatType} Chat: ${chatNumber}`);
            console.log(`   📧 Message ID: ${messageId}`);

            // Check message status
            if (statusUpdate.status !== undefined) {
                const timestamp = new Date().toLocaleString();
                console.log('statusUpdate.status');
                console.log(statusUpdate.status);

                let statusText = '';
                switch (statusUpdate.status) {
                    case 0:
                        statusText = 'pending';
                        console.log(`   ⏳ Status: PENDING at ${timestamp}`);
                        break;
                    case 1:
                        statusText = 'sent';
                        console.log(`   📤 Status: SENT at ${timestamp}`);
                        break;
                    case 3:
                        statusText = 'delivered';
                        console.log(`   ✅ Status: DELIVERED at ${timestamp}`);
                        break;
                    case 4:
                        statusText = 'read';
                        console.log(`   👀 Status: READ at ${timestamp}`);
                        break;
                    default:
                        statusText = 'unknown';
                        console.log(`   ❓ Status: UNKNOWN (${statusUpdate.status}) at ${timestamp}`);
                }

                // Update message status in database
                try {
                    // Debug: Check if message exists in database before updating
                    setTimeout(() => {
                        const existingMessage = database.getMessage(messageId);
                        if (existingMessage) {
                            console.log(`🔍 DEBUG: Found message in database for ID ${messageId}, current status: ${existingMessage.status}`);
                            database.updateMessageStatus(messageId, statusText);
                            console.log(`✅ Message status updated in database: ${statusText} (ID: ${messageId})`);
                        } else {
                            console.log(`⚠️ DEBUG: Message ID ${messageId} not found in database - cannot update status`);
                            console.log(`🔍 DEBUG: This might be why status updates aren't working for outgoing messages`);
                        }
                    }, 5000); // 5000 ms = 5 seconds
                } catch (error) {
                    console.error(`❌ Error updating message status for ID ${messageId}:`, error);
                }
            }

            // For group messages, show read receipts from individual participants
            if (statusUpdate.userReceipt && statusUpdate.userReceipt.length > 0) {
                console.log(`   📋 Read Receipts:`);
                statusUpdate.userReceipt.forEach(receipt => {
                    const userNumber = receipt.userJid.split('@')[0];
                    const receiptTime = new Date(receipt.receiptTimestamp * 1000).toLocaleString();
                    const receiptStatus = receipt.receiptType === 1 ? 'READ' : 'DELIVERED';
                    console.log(`     👤 ${userNumber}: ${receiptStatus} at ${receiptTime}`);
                });
            }

            console.log('   ─────────────────────────────');
        }
    });

    // sock.ev.on('message-receipt.update', async (updates) => {
    //     console.log('\n📬 Message Receipt Update:');
    //     fs.writeFileSync('messageReceipt.json', JSON.stringify(updates, null, 2));
    //
    //     for (const update of updates) {
    //         const { key, receipt } = update;
    //         const chatId = key.remoteJid;
    //         const messageId = key.id;
    //         const isGroup = chatId.endsWith('@g.us');
    //         const chatType = isGroup ? 'Group' : 'Individual';
    //
    //         // Extract numbers
    //         let chatNumber = chatId.split('@')[0];
    //         let participantNumber = 'N/A';
    //
    //         if (isGroup && key.participant) {
    //             participantNumber = key.participant.split('@')[0];
    //         }
    //
    //         console.log(`   📱 ${chatType} Chat: ${chatNumber}`);
    //         console.log(`   📧 Message ID: ${messageId}`);
    //
    //         if (isGroup) {
    //             console.log(`   👤 Participant: ${participantNumber}`);
    //
    //             // Get and display all group participants for context
    //             try {
    //                 const groupMetadata = await sock.groupMetadata(chatId);
    //                 const phoneNumbers = groupMetadata.participants.map(p =>
    //                     p.phoneNumber.replace('@s.whatsapp.net', '')
    //                 );
    //                 fs.writeFileSync('groupMetadata1.json', JSON.stringify(phoneNumbers));
    //                 if (groupMetadata && groupMetadata.participants) {
    //                     console.log(`   📋 All Group Participants (${groupMetadata.participants.length} members):`);
    //                     groupMetadata.participants.forEach((participant, index) => {
    //                         const pNumber = participant.id.split('@')[0];
    //                         const isAdmin = participant.admin ? ' (Admin)' : '';
    //                         const isSuperAdmin = participant.admin === 'superadmin' ? ' (Super Admin)' : '';
    //                         const adminStatus = isSuperAdmin || isAdmin;
    //
    //                         // Highlight the participant who triggered this receipt
    //                         const isReceiptParticipant = pNumber === participantNumber ? ' 👈 (Receipt from)' : '';
    //
    //                         console.log(`      ${index + 1}. ${pNumber}${adminStatus}${isReceiptParticipant}`);
    //                     });
    //                     console.log(`   ─────────────────────────────`);
    //                 }
    //             } catch (error) {
    //                 console.log(`   ❌ Could not fetch group participants: ${error.message}`);
    //             }
    //         }
    //
    //         // Parse receipt status
    //         if (receipt) {
    //             const timestamp = new Date(receipt.receiptTimestamp * 1000).toLocaleString();
    //             console.log('receipt.receiptType');
    //             console.log(receipt);
    //             // if(receipt.userJid !== '45102139449572@lid'){
    //             //     fs.writeFileSync('receipt.json',JSON.stringify(receipt, null, 2));
    //             // }
    //             switch (receipt.receiptType) {
    //                 case 0:
    //                     console.log(`   ✅ Status: DELIVERED at ${timestamp}`);
    //                     break;
    //                 case 1:
    //                     console.log(`   👀 Status: READ at ${timestamp}`);
    //                     break;
    //                 case 2:
    //                     console.log(`   📤 Status: SENT at ${timestamp}`);
    //                     break;
    //                 default:
    //                     console.log(`   ❓ Status: UNKNOWN (${receipt.receiptType}) at ${timestamp}`);
    //             }
    //
    //             // Additional receipt info
    //             if (receipt.userJid) {
    //                 const userNumber = receipt.userJid.split('@')[0];
    //                 console.log(`   👥 User: ${userNumber}`);
    //             }
    //         }
    //
    //         console.log('   ─────────────────────────────');
    //     }
    // });

    // Connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            // Print QR code directly to terminal (simple behavior)
            // printQRCode(qr);
            
            // Store QR code globally
            currentQRCode = qr;
            
            // Store QR code in database (simple string format)
            try {
                const currentSession = sessionManager.getCurrentSession();
                
                if (currentSession && currentSession.sessionId) {
                    // Check if session is already ready - don't update QR for ready sessions
                    const sessionData = await database.getSession(currentSession.sessionId);
                    if (sessionData && sessionData.ready === 1) {
                        console.log(`⚠️ Session ${currentSession.sessionId} is already ready - skipping QR update`);
                        return;
                    }
                    
                    console.log(`🔄 Updating QR code for session: ${currentSession.sessionId}`);
                    await sessionManager.updateSessionQR(currentSession.sessionId, qr);
                    console.log('✅ QR code updated in database');
                } else {
                    console.log('⚠️ No current session found, creating new session with QR code');
                    const newSessionId = await sessionManager.initializeSession(qr);
                    console.log('✅ New session created with ID:', newSessionId);
                }
            } catch (error) {
                console.error('❌ Error storing QR code:', error.message);
            }
        }
        
        if (connection === 'close') {
            // await database.updateSessionNotReady(sessionId);
            // const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            // const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            // console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            //
            // if (sock && sock.logout) {
            //     await sock.logout();
            //     console.log('✅ Main session force logged out');
            // }

            // Delete auth directory and all related files
            // const authDir = 'auth_info_baileys';
            // console.log(`🗑️ Deleting auth files: ${authDir}...`);
            // const fs = require('fs');
            // if (fs.existsSync(authDir)) {
            //     fs.rmSync(authDir, { recursive: true, force: true });
            //     console.log(`✅ Auth files deleted: ${authDir}`);
            // }

            // database.updateSessionNotReady(sessionId);
            
            // Handle specific error cases
            // if (statusCode === 401) {
            //     console.log('\n❌ SESSION CONFLICT DETECTED!');
            //     console.log('🔧 This usually means:');
            //     console.log('   1. WhatsApp Web is open in your browser');
            //     console.log('   2. Another bot instance is running');
            //     console.log('   3. Multiple sessions are using the same account');
            //     console.log('\n💡 SOLUTIONS:');
            //     console.log('   1. Close WhatsApp Web in your browser');
            //     console.log('   2. Stop other bot instances');
            //     console.log('   3. Delete auth files: rm -rf auth_info_baileys');
            //     console.log('   4. Restart the bot and scan QR code again\n');
            //
            //     // Force logout and delete auth files
            //     try {
            //         console.log('🔄 Force logging out main session...');
            //
            //         // Force logout if socket exists
            //         if (sock && sock.logout) {
            //             await sock.logout();
            //             console.log('✅ Main session force logged out');
            //         }
            //
            //         // Delete auth directory and all related files
            //         const authDir = 'auth_info_baileys';
            //         console.log(`🗑️ Deleting auth files: ${authDir}...`);
            //         const fs = require('fs');
            //         if (fs.existsSync(authDir)) {
            //             fs.rmSync(authDir, { recursive: true, force: true });
            //             console.log(`✅ Auth files deleted: ${authDir}`);
            //         }
            //
            //     } catch (error) {
            //         console.error('❌ Error during force logout/cleanup for main session:', error.message);
            //     }
            //
            //     // Don't auto-reconnect for session conflicts
            //     return;
            // }
            //
            // if (shouldReconnect) {
            //     console.log('🔄 Attempting to reconnect...');
            //     setTimeout(() => {
            //     startWhatsApp();
            //     }, 5000); // Wait 5 seconds before reconnecting
            // }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connection opened successfully!');
            console.log('🔍 Listening for new chats and message statuses...\n');
            
            // Mark session as ready in database
            try {
                const phoneNumber = sock.user?.id?.split(':')[0] || 'unknown';
                await sessionManager.markSessionReady(phoneNumber);
                console.log(`📱 Session ready for phone: ${phoneNumber}`);
            } catch (error) {
                console.error('❌ Error marking session as ready:', error.message);
                console.log('💡 Bot will continue without database storage');
            }
            
            // Sync missed messages if this is a reconnection
            if (!isFirstConnection && lastSyncTime) {
                console.log('🔄 Server reconnected - syncing missed messages...');
                await syncMissedMessages(sock);
            } else if (isFirstConnection) {
                console.log('🆕 First connection - will sync all messages during history sync');
                isFirstConnection = false;
            }
            
            // History sync will be triggered automatically by WhatsApp through messaging-history.set event
            // This happens because syncFullHistory: true and shouldSyncHistoryMessage: () => true are set
            console.log('📡 Waiting for automatic history sync from WhatsApp...');

            // Update last sync time
            lastSyncTime = Date.now();

            // Get initial chat count
            getChatCounts(sock);

            // Manually trigger history fetch for chats that need syncing
            // This is a fallback for when automatic sync doesn't provide all messages
            setTimeout(async () => {
                console.log('📊 Message status tracking is active');

                // Fetch history for existing chats from database
                try {
                    console.log(`\n${'='.repeat(60)}`);
                    console.log(`🔄 MANUAL HISTORY SYNC for session ${sessionId}`);
                    console.log(`${'='.repeat(60)}`);

                    // Get all chats for this session from database
                    const [dbChats] = await database.pool.execute(
                        'SELECT id, name, last_message_timestamp FROM chats WHERE session_id = ? ORDER BY last_message_timestamp DESC LIMIT 50',
                        [sessionId]
                    );

                    console.log(`📂 Found ${dbChats.length} chats in database to sync`);

                    let syncedChats = 0;
                    for (const chat of dbChats) {
                        try {
                            // Get the oldest message we have for this chat
                            const [oldestMsg] = await database.pool.execute(
                                'SELECT id, timestamp FROM messages WHERE chat_id = ? AND session_id = ? ORDER BY timestamp ASC LIMIT 1',
                                [chat.id, sessionId]
                            );

                            if (oldestMsg.length > 0) {
                                // Request messages older than what we have
                                const msgKey = {
                                    remoteJid: chat.id,
                                    id: oldestMsg[0].id,
                                    fromMe: false
                                };

                                console.log(`   📨 Fetching history for: ${chat.name || chat.id}`);

                                // Use fetchMessageHistory to get more messages
                                await sock.fetchMessageHistory(50, msgKey, oldestMsg[0].timestamp);
                                syncedChats++;

                                // Small delay to avoid rate limiting
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
                        } catch (chatError) {
                            // Silent fail for individual chats
                            console.log(`   ⚠️ Could not sync ${chat.name || chat.id}: ${chatError.message}`);
                        }
                    }

                    console.log(`✅ Manual history sync requested for ${syncedChats} chats`);
                    console.log(`${'='.repeat(60)}\n`);
                } catch (error) {
                    console.log(`⚠️ Manual history sync skipped: ${error.message}`);
                }
            }, 5000); // Wait 5 seconds for automatic sync to complete first
        }
    });

    // Listen for new chat events
    sock.ev.on('chats.upsert', async (chats) => {
        console.log('\n🆕 New chat(s) detected:');
        
        for (const chat of chats) {
            const chatType = chat.id.endsWith('@g.us') ? 'Group' : 'Individual';
            const chatName = chat.name || chat.id.split('@')[0];
            console.log(`   📞 ${chatType} Chat: ${chatName} (${chat.id})`);
            
            // Store chat in database
            try {
                const { sessionId } = sessionManager.getCurrentSession();
                if (sessionId) {
                    await storeChatInDatabase(chat, sock, sessionId);
                }
            } catch (error) {
                console.error(`❌ Error storing chat ${chat.id}:`, error);
            }
        }
        
        // Update chat counts after new chats
        getChatCounts(sock);
    });

    // Listen for chat updates (including new messages that might create new chats)
    sock.ev.on('chats.update', (updates) => {
        const newChats = updates.filter(update => update.unreadCount !== undefined);
        if (newChats.length > 0) {
            console.log('\n📬 Chat updates detected - checking for new chats...');
            getChatCounts(sock);
        }
    });

    // Listen for messages (to detect new chats from first messages)
    // Listen for message receipt updates (delivered, read status)
    sock.ev.on('message-receipt.update', async (updates) => {
        console.log('\n📬 Message Receipt Update:');
        // fs.writeFileSync('messageReceipt.json', JSON.stringify(updates, null, 2));
        
        for (const update of updates) {
            const { key, receipt } = update;
            const chatId = key.remoteJid;
            const messageId = key.id;
            const isGroup = chatId.endsWith('@g.us');
            const chatType = isGroup ? 'Group' : 'Individual';
            
            // Extract numbers
            let chatNumber = chatId.split('@')[0];
            let participantNumber = 'N/A';
            
            if (isGroup && key.participant) {
                participantNumber = key.participant.split('@')[0];
            }
            
            console.log(`   📱 ${chatType} Chat: ${chatNumber}`);
            console.log(`   📧 Message ID: ${messageId}`);
            
            if (isGroup) {
                console.log(`   👤 Participant: ${participantNumber}`);
                
                // Get and display all group participants for context
                try {
                    const groupMetadata = await sock.groupMetadata(chatId);
                    const phoneNumbers = groupMetadata.participants.map(p =>
                        p.phoneNumber.replace('@s.whatsapp.net', '')
                      );
                      // fs.writeFileSync('groupMetadata1.json', JSON.stringify(phoneNumbers));
                    if (groupMetadata && groupMetadata.participants) {
                        console.log(`   📋 All Group Participants (${groupMetadata.participants.length} members):`);
                        groupMetadata.participants.forEach((participant, index) => {
                            const pNumber = participant.id.split('@')[0];
                            const isAdmin = participant.admin ? ' (Admin)' : '';
                            const isSuperAdmin = participant.admin === 'superadmin' ? ' (Super Admin)' : '';
                            const adminStatus = isSuperAdmin || isAdmin;
                            
                            // Highlight the participant who triggered this receipt
                            const isReceiptParticipant = pNumber === participantNumber ? ' 👈 (Receipt from)' : '';
                            
                            console.log(`      ${index + 1}. ${pNumber}${adminStatus}${isReceiptParticipant}`);
                        });
                        console.log(`   ─────────────────────────────`);
                    }
                } catch (error) {
                    console.log(`   ❌ Could not fetch group participants: ${error.message}`);
                }
            }
            
            // Parse receipt status
            if (receipt) {
                const timestamp = new Date(receipt.receiptTimestamp * 1000).toLocaleString();
                console.log('receipt.receiptType');
                console.log(receipt);
                // if(receipt.userJid !== '45102139449572@lid'){
                //     fs.writeFileSync('receipt.json',JSON.stringify(receipt, null, 2));
                // }
                switch (receipt.receiptType) {
                    case 0:
                        console.log(`   ✅ Status: DELIVERED at ${timestamp}`);
                        break;
                    case 1:
                        console.log(`   👀 Status: READ at ${timestamp}`);
                        break;
                    case 2:
                        console.log(`   📤 Status: SENT at ${timestamp}`);
                        break;
                    default:
                        console.log(`   ❓ Status: UNKNOWN (${receipt.receiptType}) at ${timestamp}`);
                }
                
                // Additional receipt info
                if (receipt.userJid) {
                    const userNumber = receipt.userJid.split('@')[0];
                    console.log(`   👥 User: ${userNumber}`);
                }
            }
            
            console.log('   ─────────────────────────────');
        }
    });

    // p
    sock.ev.on('presence.update', (presenceUpdate) => {
        const { id, presences } = presenceUpdate;
        const chatNumber = id.split('@')[0];
        const isGroup = id.endsWith('@g.us');
        const chatType = isGroup ? 'Group' : 'Individual';
        
        console.log(`\n👁️  Presence Update in ${chatType} Chat: ${chatNumber}`);
        
        Object.entries(presences).forEach(([participantId, presence]) => {
            const participantNumber = participantId.split('@')[0];
            const lastKnownPresence = presence.lastKnownPresence;
            const lastSeen = presence.lastSeen;
            
            console.log(`   👤 Participant: ${participantNumber}`);
            console.log(`   📶 Status: ${lastKnownPresence || 'unknown'}`);
            
            if (lastSeen) {
                const lastSeenTime = new Date(lastSeen * 1000).toLocaleString();
                console.log(`   ⏰ Last Seen: ${lastSeenTime}`);
            }
        });
        console.log('   ─────────────────────────────');
    });

// Track incoming message status lifecycle
const messageStatusTracker = new Map();

// Debug counter for message status updates
let messageStatusUpdateCount = 0;

    sock.ev.on('messages.upsert', async (messageUpdate) => {
        const { messages, type } = messageUpdate;
        console.log('typeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
        console.log(type);
        
        if (type === 'notify' || type === 'append') {
            if (type === 'append') {
                console.log();
            }
            let inx=0;
            for (const message of messages) {
                // First, ensure the chat exists in database
                inx+=1;
                // fs.writeFileSync('0fff'+inx,JSON.stringify(message));
                try {
                    const { sessionId } = sessionManager.getCurrentSession();
                    if (sessionId) {
                        await ensureChatExists(message, sock, sessionId);
                    }
                } catch (error) {
                    console.error(`❌ Error ensuring chat exists:`, error);
                }
                
                // Store message in database (both incoming and outgoing)
                try {
                    console.log('messages.upsert event')
                    const { sessionId } = database.getDataSession();
                    if (sessionId) {
                        await storeMessageInDatabase(message, sock, sessionId);
                    }
                } catch (error) {
                    console.error(`❌ Error storing message ${message.key.id}:`, error);
                }
                
                if (message.key.fromMe === false) {
                    const chatId = message.key.remoteJid;
                    const isGroup = chatId.endsWith('@g.us');
                    const chatType = isGroup ? 'Group' : 'Individual';
                    
                    // Extract actual phone numbers
                    let senderNumber = 'Unknown';
                    let chatNumber = 'Unknown';
                    
                    if (isGroup) {
                        // In group chats, the participant field contains the sender's number
                        try {
                            const groupMetadata = await sock.groupMetadata(message.key.remoteJid);
                            const senderParticipant = groupMetadata.participants.find(obj => obj.id === message.key.participant);
                            
                            if (senderParticipant && senderParticipant.phoneNumber) {
                                senderNumber = senderParticipant.phoneNumber.replace('@s.whatsapp.net', '');
                            } else {
                                // Fallback to participant ID
                                senderNumber = message.key.participant.split('@')[0];
                            }
                        } catch (error) {
                            console.error('❌ Error getting group metadata for display:', error.message);
                                senderNumber = message.key.participant.split('@')[0];
                        }
                        
                        // Group chat ID format: 120363419271232089@g.us
                        chatNumber = chatId.split('@')[0];
                        
                        console.log(`\n💬 New message in ${chatType} chat:`);
                        console.log(`   📱 Group ID: ${chatNumber}`);
                        console.log(`   👤 Sender Number: ${senderNumber}`);
                        console.log(`   👥 Full Chat ID: ${chatId}`);
                        
                        // Get and display all group participants
                        try {
                            const groupMetadata = await sock.groupMetadata(chatId);
                        
                            const phoneNumbers = groupMetadata.participants.map(p =>
                                p.phoneNumber.replace('@s.whatsapp.net', '')
                              );
                              // fs.writeFileSync('groupMetadata3.json', JSON.stringify(phoneNumbers));
                        
                            if (groupMetadata && groupMetadata.participants) {
                                console.log(`   📋 Group Participants (${groupMetadata.participants.length} members):`);
                                groupMetadata.participants.forEach((participant, index) => {
                                    const participantNumber = participant.id.split('@')[0];
                                    const isAdmin = participant.admin ? ' (Admin)' : '';
                                    const isSuperAdmin = participant.admin === 'superadmin' ? ' (Super Admin)' : '';
                                    const adminStatus = isSuperAdmin || isAdmin;
                                    
                                    // Highlight the sender
                                    const isSender = participantNumber === senderNumber ? ' 👈 (Sender)' : '';
                                    
                                    console.log(`      ${index + 1}. ${participantNumber}${adminStatus}${isSender}`);
                                });
                                console.log(`   ─────────────────────────────`);
                            }
                        } catch (error) {
                            console.log(`   ❌ Could not fetch group participants: ${error.message}`);
                        }
                        
                        // Display message content if available
                        if (message.message) {
                            let messageText = '';
                            if (message.message.conversation) {
                                messageText = message.message.conversation;
                            } else if (message.message.extendedTextMessage) {
                                messageText = message.message.extendedTextMessage.text;
                            }
                            if (messageText) {
                                console.log(`   💭 Message: "${messageText}"`);
                            }
                        }
                        
                        // Display sender name if available
                        if (message.pushName) {
                            console.log(`   🏷️  Sender Name: ${message.pushName}`);
                        }
                        
                    } else {
                        // In individual chats, the remoteJid is the sender's number
                            senderNumber = chatId.split('@')[0];
                        
                        console.log(`\n💬 New message in ${chatType} chat:`);
                        console.log(`   📱 Sender Number: ${senderNumber}`);
                        console.log(`   📞 Full Chat ID: ${chatId}`);
                        
                        // Display message content if available
                        if (message.message) {
                            let messageText = '';
                            if (message.message.conversation) {
                                messageText = message.message.conversation;
                            } else if (message.message.extendedTextMessage) {
                                messageText = message.message.extendedTextMessage.text;
                            }
                            if (messageText) {
                                console.log(`   💭 Message: "${messageText}"`);
                            }
                        }
                        
                        // Display sender name if available
                        if (message.pushName) {
                            console.log(`   🏷️  Sender Name: ${message.pushName}`);
                        }
                    }
                    
                    console.log(`   ⏰ Timestamp: ${new Date(message.messageTimestamp * 1000).toLocaleString()}`);
                    
                    // Log initial message status when received
                    console.log(`   📊 Initial Message Status: RECEIVED`);
                    
                    // Store message in tracker for status monitoring
                    const messageKey = `${chatId}_${message.key.id}`;
                    messageStatusTracker.set(messageKey, {
                        chatId,
                        messageId: message.key.id,
                        senderNumber: isGroup ? senderNumber : senderNumber,
                        chatType,
                        receivedAt: new Date(),
                        status: 'RECEIVED',
                        messageContent: message.message?.conversation || 'Media/Other'
                    });
                    
                    // Auto-send read receipt and log the action
                    setTimeout(async () => {
                        try {
                            await sock.readMessages([message.key]);
                            console.log(`   👀 Read receipt sent for message: ${message.key.id}`);
                            
                            // Update tracker
                            const trackedMessage = messageStatusTracker.get(messageKey);
                            if (trackedMessage) {
                                // trackedMessage.status = 'READ_RECEIPT_SENT';
                                trackedMessage.status = 'delivered';
                                trackedMessage.readAt = new Date();
                                console.log(`   📋 Message status updated: ${trackedMessage.status}`);
                                await database.updateMessageStatus(message.key.id, trackedMessage.status);
                            }
                        } catch (error) {
                            console.log(`   ❌ Failed to send read receipt: ${error.message}`);
                            
                            // Update tracker with error
                            const trackedMessage = messageStatusTracker.get(messageKey);
                            if (trackedMessage) {
                                trackedMessage.status = 'READ_RECEIPT_FAILED';
                                trackedMessage.error = error.message;
                                await database.updateMessageStatus(message.key.id, trackedMessage.status);
                            }
                        }
                    }, 1000); // Delay to simulate natural reading time
                    
                    console.log('   ─────────────────────────────');
                }
            }
        }
        if (type === 'revoke') {
            console.log('revokeeeeeeeeeeeeeeeeeeeeeeeeee');
            console.log(message);
        }
    });

    // Listen for message status updates (for messages you send)
    sock.ev.on('messages.update', async (messageUpdates) => {
        messageStatusUpdateCount++;
        console.log('\n📊 Message Status Update:');
        console.log(`🔍 DEBUG: Update #${messageStatusUpdateCount} - Total updates received:`, messageUpdates.length);
        // fs.writeFileSync('messageStatusUpdate.json', JSON.stringify(messageUpdates, null, 2));
        
        for (const update of messageUpdates) {
            const { key, update: statusUpdate } = update;
            const chatId = key.remoteJid;
            const messageId = key.id;
            const isGroup = chatId.endsWith('@g.us');
            const chatType = isGroup ? 'Group' : 'Individual';
            const chatNumber = chatId.split('@')[0];
            
            console.log(`   📱 ${chatType} Chat: ${chatNumber}`);
            console.log(`   📧 Message ID: ${messageId}`);
            
            // Check message status
            if (statusUpdate.status !== undefined) {
                const timestamp = new Date().toLocaleString();
                console.log('statusUpdate.status');
                console.log(statusUpdate.status);
                
                let statusText = '';
                switch (statusUpdate.status) {
                    case 0:
                        statusText = 'pending';
                        console.log(`   ⏳ Status: PENDING at ${timestamp}`);
                        break;
                    case 1:
                        statusText = 'sent';
                        console.log(`   📤 Status: SENT at ${timestamp}`);
                        break;
                    case 3:
                        statusText = 'delivered';
                        console.log(`   ✅ Status: DELIVERED at ${timestamp}`);
                        break;
                    case 4:
                        statusText = 'read';
                        console.log(`   👀 Status: READ at ${timestamp}`);
                        break;
                    default:
                        statusText = 'unknown';
                        console.log(`   ❓ Status: UNKNOWN (${statusUpdate.status}) at ${timestamp}`);
                }
                
                // Update message status in database
                try {
                    // Debug: Check if message exists in database before updating
                    setTimeout(() => {
                        const existingMessage = database.getMessage(messageId);
                        if (existingMessage) {
                            console.log(`🔍 DEBUG: Found message in database for ID ${messageId}, current status: ${existingMessage.status}`);
                            database.updateMessageStatus(messageId, statusText);
                            console.log(`✅ Message status updated in database: ${statusText} (ID: ${messageId})`);
                        } else {
                            console.log(`⚠️ DEBUG: Message ID ${messageId} not found in database - cannot update status`);
                            console.log(`🔍 DEBUG: This might be why status updates aren't working for outgoing messages`);
                        }
                      }, 5000); // 5000 ms = 5 seconds
                } catch (error) {
                    console.error(`❌ Error updating message status for ID ${messageId}:`, error);
                }
            }
            
            // For group messages, show read receipts from individual participants
            if (statusUpdate.userReceipt && statusUpdate.userReceipt.length > 0) {
                console.log(`   📋 Read Receipts:`);
                statusUpdate.userReceipt.forEach(receipt => {
                    const userNumber = receipt.userJid.split('@')[0];
                    const receiptTime = new Date(receipt.receiptTimestamp * 1000).toLocaleString();
                    const receiptStatus = receipt.receiptType === 1 ? 'READ' : 'DELIVERED';
                    console.log(`     👤 ${userNumber}: ${receiptStatus} at ${receiptTime}`);
                });
            }
            
            console.log('   ─────────────────────────────');
        }
    });

    // Listen for messaging history sync
    // sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, syncType }) => {
    //     console.log('⚡ History Sync Event Triggered!');
    //     console.log('Sync Type:', syncType);
    //     console.log('Chats count:', chats.length);
    //     console.log('Contacts count:', contacts.length);
    //     console.log('Messages count:', messages.length);
    //
    //     // Store synced chats in database
    //     for (const chat of chats) {
    //         try {
    //             const { sessionId } = sessionManager.getCurrentSession();
    //             if (sessionId) {
    //                 await storeChatInDatabase(chat, sock, sessionId);
    //             }
    //         } catch (error) {
    //             console.error(`❌ Error storing synced chat ${chat.id}:`, error);
    //         }
    //     }
    //
    //     // Store synced messages in database (skip recent messages to avoid duplicates)
    //     const currentTime = Date.now();
    //     const fiveMinutesAgo = currentTime - (5 * 60 * 1000); // 5 minutes ago
    //
    //     for (const message of messages) {
    //         try {
    //             // Skip messages that are very recent (likely already processed by messages.upsert)
    //             const messageTime = Number(message.messageTimestamp) * 1000; // Convert to milliseconds
    //             if (messageTime > fiveMinutesAgo) {
    //                 console.log(`⏭️ Skipping recent message ${message.key.id} from history sync (already processed)`);
    //                 continue;
    //             }
    //             console.log('messag-history.set')
    //             const { sessionId } = sessionManager.getCurrentSession();
    //             if (sessionId) {
    //                 await storeMessageInDatabase(message, sock, sessionId);
    //             }
    //     } catch (error) {
    //             console.error(`❌ Error storing synced message ${message.key.id}:`, error);
    //         }
    //     }
    //
    //     console.log('✅ History sync completed and stored in database');
    // });
}

// Helper function to ensure chat exists in database
async function ensureChatExists(message, sock, sessionId) {
    try {
        // fs.writeFileSync('0sss.json',JSON.stringify(message));
        let chatId= message.key.remoteJidAlt  || message.key.remoteJid

        if (!sessionId) {
            console.log('⚠️ No session ID provided for ensuring chat exists');
            return;
        }

        // Check if chat already exists in database
        // const existingChat = await database.getChat(sessionManager.generateChatId(chatId,sessionId), sessionId);
        // fs.writeFileSync('islam.txt', JSON.stringify(existingChat, null, 2));
        // if (existingChat) {
            // console.log(`✅ Chat already exists in database: ${chatId}`);
            // existingChat.name
            // return;
        // }

        // Create a basic chat object from the chatId
        const isGroup = chatId.endsWith('@g.us');
        let chatName = 'Unknown';
        let phoneNumbers = [];

        if (isGroup) {
            // For groups, try to get metadata
            try {
                const groupMetadata = await sock.groupMetadata(chatId);
                chatName = groupMetadata.subject || 'Group Chat';
               
                phoneNumbers = groupMetadata.participants.map(p =>
                    p.phoneNumber.replace('@s.whatsapp.net', '')
                  );
            } catch (error) {
                console.log(`⚠️ Could not get group metadata for ${chatId}, using basic info`);
                chatName = 'Group Chat';
                phoneNumbers = [chatId.split('@')[0]];
            }
        } else {
            // For individual chats - get WhatsApp profile name (highest priority)
            try {
                if (message.key.fromMe) {
                    // For outgoing messages (sent by us), get recipient's WhatsApp profile name
                    const phoneNum = chatId.split('@')[0];
                    
                    // Try to get WhatsApp profile name - try multiple methods
                    let profileName = null;
                    
                    try {
                        // Method 1: Check stored contacts
                        const contacts = sock.store?.contacts || {};
                        const contact = contacts[chatId];
                        if (contact?.name) {
                            profileName = contact.name;
                        } else if (contact?.notify) {
                            profileName = contact.notify;
                        }
                    } catch (err) {
                        // Continue to next method
                    }
                    
                    // Method 2: Try to get from onWhatsApp
                    if (!profileName) {
                        try {
                            const [waContact] = await sock.onWhatsApp(chatId);
                            if (waContact?.notify) {
                                profileName = waContact.notify;
                            }
                        } catch (err) {
                            // Continue
                        }
                    }
                    
                    // Method 3: Check database for existing chat with this contact
                    if (!profileName) {
                        try {
                            const existingChat = await database.getChatByPhoneNumber(phoneNum, sessionId);
                            if (existingChat?.name && existingChat.name !== phoneNum) {
                                profileName = existingChat.name;
                            }
                        } catch (err) {
                            // Continue
                        }
                    }
                    
                    chatName = profileName || phoneNum;
                } else {
                    // For incoming messages, use sender's pushName (their WhatsApp profile name)
                    chatName = message.pushName || message.verifiedBizName || chatId.split('@')[0];
                }
            } catch (error) {
                // Fallback to phone number if anything goes wrong
                chatName = chatId.split('@')[0];
            }
            phoneNumbers = [chatId.split('@')[0]];
        }

        // Create chat data - store as proper JSON array
        let phoneNumberString;
        if (isGroup) {
            // For groups, store all participant phone numbers as JSON array
            phoneNumberString = JSON.stringify(phoneNumbers);
        } else {
            // For individual chats, store as JSON array with single phone
            phoneNumberString = JSON.stringify([phoneNumbers[0] || 'unknown']);
        }

        const chatData = {
            id: sessionManager.generateChatId(chatId,sessionId),
            sessionId: sessionId,
            name: chatName,
            phoneNumber: phoneNumberString,
            isGroup: isGroup ? 1 : 0,
            lastMessageId: null,
            lastMessageTimestamp: null
        };

        console.log('📝 Creating new chat:', JSON.stringify(chatData, null, 2));
        await database.createOrUpdateChat(chatData);
        console.log(`✅ Chat created: ${chatName} (${isGroup ? 'Group' : 'Individual'})`);

    } catch (error) {
        console.error('❌ Error in ensureChatExists:', error.message);
        throw error;
    }
}

// Helper function to store chat in database
async function storeChatInDatabase(chat, sock, sessionId) {
    try {
        console.log(`🔍 Attempting to store chat. Session ID: ${sessionId}`);
        
        if (!sessionId) {
            console.log('⚠️ No session ID provided for storing chat');
            return;
        }

        const isGroup = chat.id.endsWith('@g.us');
        const isSinge = chat.id.endsWith('s.whatsapp.net');
        let phoneNumbers = [];
        let chatName = 'Unknown';

        if (isGroup) {
            // For groups, use subject or name
            chatName = chat.subject || chat.name || 'Unknown Group';
            // For groups, get all participant phone numbers
            try {
                const groupMetadata = await sock.groupMetadata(chat.id);
                phoneNumbers = groupMetadata.participants.map(p => {
                    if (p.phoneNumber) {
                        return p.phoneNumber.replace('@s.whatsapp.net', '');
                    } else {
                        return p.id.split('@')[0];
                    }
                });
            } catch (error) {
                console.log(`⚠️ Could not get group metadata for ${chat.id}`);
                phoneNumbers = [chat.id.split('@')[0]];
            }
        } else {
            // For individual chats, try to get contact name from multiple sources
            // Priority: 1. chat.name, 2. chat.notify, 3. chat.verifiedName, 4. socket contacts, 5. onWhatsApp lookup
            chatName = chat.name || chat.notify || chat.verifiedName || null;

            // If no name found, try to get from socket contacts
            if (!chatName) {
                try {
                    const contacts = sock.store?.contacts || {};
                    const contact = contacts[chat.id];
                    if (contact?.name) {
                        chatName = contact.name;
                    } else if (contact?.notify) {
                        chatName = contact.notify;
                    } else if (contact?.verifiedName) {
                        chatName = contact.verifiedName;
                    }
                } catch (err) {
                    console.log(`⚠️ Could not get contact from store for ${chat.id}`);
                }
            }

            // If still no name, try onWhatsApp lookup to get profile name
            if (!chatName && sock) {
                try {
                    const [waContact] = await sock.onWhatsApp(chat.id);
                    if (waContact?.notify) {
                        chatName = waContact.notify;
                    }
                } catch (err) {
                    console.log(`⚠️ Could not get profile name via onWhatsApp for ${chat.id}`);
                }
            }

            // Final fallback to phone number
            if (!chatName) {
                chatName = chat.id.split('@')[0];
            }

            // For individual chats, get the other person's number
            phoneNumbers = [chat.id.split('@')[0]];
        }

        // For individual chats, store just the phone number
        // For groups, store the first few numbers (due to VARCHAR(255) limit)
        let phoneNumberString;
        if (isGroup) {
            // For groups, store first 3 numbers as JSON array
            phoneNumberString = JSON.stringify(phoneNumbers.slice(0, 3));
        } else {
            // For individual chats, store just the one number as JSON array
            phoneNumberString = JSON.stringify([phoneNumbers[0] || 'unknown']);
        }
    

        const chatData = {
            id: `${chat.id}_${sessionId}`,
            sessionId: sessionId,
            name: chatName,
            phoneNumber: phoneNumberString, // Store as comma-separated string
            isGroup: isGroup ? 1 : 0,
            lastMessageId: null, // Will be updated when messages are stored
            lastMessageTimestamp: null // Will be updated when messages are stored
        };

        console.log('📝 Chat data to store:', JSON.stringify(chatData, null, 2));
        await database.createOrUpdateChat(chatData);
        console.log(`✅ Chat stored: ${chatName} (${isGroup ? 'Group' : 'Individual'})`);
    } catch (error) {
        console.error('❌ Error in storeChatInDatabase:', error.message);
        
        // Handle specific database errors
        if (error.code === 'WARN_DATA_TRUNCATED') {
            console.log('⚠️ Data truncation error - this usually means:');
            console.log('   1. A column is too small for the data being inserted');
            console.log('   2. Run: node fix-database-schema.js to fix this');
        } else if (error.code === 'ER_NO_SUCH_TABLE') {
            console.log('⚠️ Table does not exist - please create the required tables');
        } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.log('⚠️ Database access denied - check your credentials');
        }
        
        // Don't throw error to prevent bot crash
        console.log('💡 Bot will continue without storing this chat');
    }
}

async function handleRevoke(id) {
    await database.pool.execute(
        'DELETE FROM messages WHERE id = ?',
        [id]
    );
}

// Helper function to upload media to S3
async function uploadMediaToS3(message, sock) {
    try {
        // Check if sock is null or doesn't have updateMediaMessage
        if (!sock || !sock.updateMediaMessage) {
            console.error('❌ Socket is null or missing updateMediaMessage method');
            throw new Error('Socket not available for media download');
        }
        
        const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        // AWS S3 configuration (same as test-aws-connection.js)

        const accessKey =  process.env.AWS_ACCESS_KEY_ID
        const secretKey =  process.env.AWS_SECRET_ACCESS_KEY
        const region =  process.env.AWS_DEFAULT_REGION
        const bucket =  process.env.AWS_BUCKET
        const AWS_URL =  process.env.AWS_URL
        
        // Create S3 client
        const s3Client = new S3Client({
            credentials: {
                accessKeyId: accessKey,
                secretAccessKey: secretKey,
            },
            region: region,
        });
        
        // Download media from WhatsApp
        console.log('📥 Downloading media from WhatsApp...');
        const buffer = await downloadMediaMessage(
            message,
            'buffer',
            {},
            {
                logger: console,
                reuploadRequest: sock.updateMediaMessage
            }
        );
        
        if (!buffer || buffer.length === 0) {
            throw new Error('Failed to download media - empty buffer');
        }
        
        console.log(`📥 Media downloaded successfully, size: ${buffer.length} bytes`);
        
        // Generate unique filename
        const timestamp = Date.now();
        const messageId = message.key.id;
        const mediaType = s3Service.getMediaType(message);
        
        let fileExtension = '';
        let contentType = 'application/octet-stream';
        
        // Determine file extension and content type based on media type
        switch (mediaType) {
            case 'image':
            case 'image/jpeg':
                fileExtension = '.jpg';
                contentType = 'image/jpeg';
                break;
            case 'image/png':
                fileExtension = '.png';
                contentType = 'image/png';
                break;
            case 'image/gif':
                fileExtension = '.gif';
                contentType = 'image/gif';
                break;
            case 'image/webp':
                fileExtension = '.webp';
                contentType = 'image/webp';
                break;
            case 'video':
            case 'video/mp4':
                fileExtension = '.mp4';
                contentType = 'video/mp4';
                break;
            case 'video/3gpp':
                fileExtension = '.3gp';
                contentType = 'video/3gpp';
                break;
            case 'audio':
            case 'audio/mpeg':
            case 'audio/mp3':
                fileExtension = '.mp3';
                contentType = 'audio/mpeg';
                break;
            case 'audio/ogg':
                fileExtension = '.ogg';
                contentType = 'audio/ogg';
                break;
            case 'audio/amr':
                fileExtension = '.amr';
                contentType = 'audio/amr';
                break;
            case 'document':
            case 'application/pdf':
                fileExtension = '.pdf';
                contentType = 'application/pdf';
                break;
            case 'application/msword':
                fileExtension = '.doc';
                contentType = 'application/msword';
                break;
            case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                fileExtension = '.docx';
                contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                break;
            case 'application/vnd.ms-excel':
                fileExtension = '.xls';
                contentType = 'application/vnd.ms-excel';
                break;
            case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
                fileExtension = '.xlsx';
                contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
                break;
            case 'sticker':
                fileExtension = '.webp';
                contentType = 'image/webp';
                break;
            default:
                fileExtension = '.bin';
                contentType = 'application/octet-stream';
        }
        
        const fileName = `whatsapp-media/${messageId}_${timestamp}${fileExtension}`;
        
        // Upload to S3
        const putObjectCommand = new PutObjectCommand({
            Bucket: bucket,
            Key: fileName,
            Body: buffer,
            ContentType: contentType
        });
        
        await s3Client.send(putObjectCommand);
        
        // Return the S3 URL
        const s3Url = `${fileName}`;
        
        return {
            url: s3Url,
            fileName: fileName,
            contentType: contentType,
            size: buffer.length
        };
        
    } catch (error) {
        console.error('❌ Error uploading media to S3:', error);
        throw error;
    }
}

// Helper function to store message in database
async function storeMessageInDatabase(message, sock, sessionId) {
    console.log('storeMessageInDatabase storeMessageInDatabase storeMessageInDatabase storeMessageInDatabase storeMessageInDatabase storeMessageInDatabase storeMessageInDatabase');
    // console.log(message.message.protocolMessage.type);
    // console.log(message.message.protocolMessage.key.id);
    let checkDelete=  message &&
    message.message &&
    message.message.protocolMessage &&
    message.message.protocolMessage.type
    &&  message.message.protocolMessage.type == 0;
    console.log(message?.message?.protocolMessage?.type);
    if (message?.message?.protocolMessage?.type == 0) {
        console.log('deleteeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
         await handleRevoke(message.message.protocolMessage.key.id);
         return;
    }
    // fs.writeFileSync('0message.json', JSON.stringify(message, null, 2));
    try {
        console.log(`🔍 Attempting to store message. Session ID: ${sessionId}`);
        
        if (!sessionId) {
            console.log('⚠️ No session ID provided for storing message');
            return;
        }

        let chatId = message.key.remoteJid;
        const isGroup = chatId.endsWith('@g.us');
        
        // Extract sender information
        let fromNumber = 'unknown';
        let senderId = 'unknown';
        let senderName = 'Unknown';  // Default, will be overridden
        let messageStatus= 'sent'

        if (isGroup && message.key.participant) {
            try {
                const groupMetadata = await sock.groupMetadata(message.key.remoteJid);
                const senderParticipant = groupMetadata.participants.find(obj => obj.id === message.key.participant);
                
                if (senderParticipant) {
                    // Extract phone number from participant
                    if (senderParticipant.phoneNumber) {
                        fromNumber = senderParticipant.phoneNumber.replace('@s.whatsapp.net', '');
                        senderId = fromNumber;
                    } else {
                        // Fallback to participant ID
                        fromNumber = message.key.participant.split('@')[0];
                        senderId = fromNumber;
                    }
                    
                    // Get sender name from participant metadata
                    senderName = senderParticipant.name || senderParticipant.verifiedName || message.pushName || fromNumber;
                } else {
                    // Fallback if participant not found
                    fromNumber = message.key.participant.split('@')[0];
                    senderId = fromNumber;
                    senderName = message.pushName || fromNumber;
                }
            } catch (error) {
                console.error('❌ Error getting group metadata for message:', error.message);
                // Fallback to basic extraction
                fromNumber = message.key.participant.split('@')[0];
                senderId = fromNumber;
                senderName = message.pushName || fromNumber;
            }
        }
        else if (!isGroup) {
            if(message.key.fromMe){
                const sessionData = await database.getDataSession(sessionId);
                fromNumber = sessionData?.phone_number || 'unknown';
                console.log(sessionId)
                console.log(fromNumber)
                senderId = fromNumber;
                senderName = 'You';  // Message sent by user
                senderName = message.pushName || 'YOU' ;
                // fs.writeFileSync('0.json', JSON.stringify(sessionData, null, 2));
            }
            else{
                // Extract phone number from remoteJidAlt or senderPn with proper null checks
                if (message.key.remoteJidAlt) {
                    fromNumber = message.key.remoteJidAlt.split('@')[0];
                    chatId = message.key.remoteJidAlt;
                } else if (message.key.senderPn) {
                    fromNumber = message.key.senderPn.split('@')[0];
                    chatId = message.key.senderPn;
                } else {
                    // Fallback to remoteJid if neither is available
                    fromNumber = message.key.remoteJid.split('@')[0];
                    chatId = message.key.remoteJid;
                }
                senderId = fromNumber;
                
                // Get sender name from WhatsApp profile
                // Try multiple sources in order of preference
                if (message.pushName) {
                    senderName = message.pushName;
                } else if (message.verifiedBizName) {
                    senderName = message.verifiedBizName;
                } else {
                    // Try to get from socket contacts
                    try {
                        const contacts = sock.store?.contacts || {};
                        const contact = contacts[chatId];
                        if (contact?.name) {
                            senderName = contact.name;
                        } else if (contact?.notify) {
                            senderName = contact.notify;
                        } else {
                            senderName = fromNumber;  // Fallback to phone number
                        }
                    } catch (err) {
                        senderName = fromNumber;
                    }
                }
                // messageStatus='delivered'
                // console.log('000000000000000000000000000000000000000000000')
                // console.log(fromNumber)
            }
            // For individual chats, use the chat ID as the sender
        }

        // Extract message content
        const body = s3Service.extractTextContent(message) || '';
        const mediaType = s3Service.getMediaType(message);
        const hasMedia = mediaType ? 1 : 0;
        
        console.log(`🔍 Message analysis - Has media: ${hasMedia}, Media type: ${mediaType || 'none'}`);
        if (hasMedia) {
            console.log(`📱 Message structure:`, JSON.stringify(message.message, null, 2));
        }

        // Handle media upload to S3
        let mediaPreview = null;
        if (hasMedia) {
            console.log(`📁 Processing media message - Type: ${mediaType}`);
            try {
                // Use the sock parameter passed to the function, not currentSocket
                const mediaInfo = await uploadMediaToS3(message, sock);
                if (mediaInfo && mediaInfo.url) {
                    mediaPreview = mediaInfo.url;
                    console.log(`✅ Media uploaded to S3: ${mediaInfo.url}`);
                    console.log(`📊 File size: ${mediaInfo.size} bytes, Content type: ${mediaInfo.contentType}`);
                } else {
                    console.log('⚠️ Media upload returned no URL');
                }
            } catch (error) {
                console.error('❌ Error uploading media to S3:', error);
                console.error('❌ Error details:', error.message);
                // Continue without media preview if upload fails
                mediaPreview = null;
            }
        } else {
            console.log('📝 Text message - no media to upload');
        }

        const messageData = {
            id: message.key.id,
            chatId: sessionManager.generateChatId(chatId,sessionId),
            sessionId: sessionId,
            fromNumber: fromNumber,
            senderId: senderId,
            senderName: senderName,
            body: body,
            timestamp: Number(message.messageTimestamp), // Convert Long to number
            fromMe: message.key.fromMe ? 1 : 0,
            hasMedia: hasMedia,
            mediaType: mediaType,
            whatsappMessageId: message.key.id,
            mediaPreview: mediaPreview,
            parentId: message?.message?.extendedTextMessage?.contextInfo?.stanzaId || null, // For replies, extract from message
            status: messageStatus
        };

        // Clean undefined values to prevent database errors
        const cleanMessageData = {};
        for (const [key, value] of Object.entries(messageData)) {
            cleanMessageData[key] = value === undefined ? null : value;
        }

        console.log('📝 Message data to store:', JSON.stringify(cleanMessageData, null, 2));
        await database.createMessage(cleanMessageData);
        console.log(`✅ Message stored: ${body.substring(0, 50)}${body.length > 50 ? '...' : ''}`);
        
        // Update chat's last message info
        try {
            await updateChatLastMessage(chatId, message.key.id, Number(message.messageTimestamp), sessionId);
        } catch (error) {
            console.error('❌ Error updating chat last message:', error.message);
        }
    } catch (error) {
        console.error('❌ Error storing message:', error);

        
        // Handle specific database errors
        if (error.code === 'WARN_DATA_TRUNCATED') {
            console.log('⚠️ Data truncation error - this usually means:');
            console.log('   1. A column is too small for the data being inserted');
            console.log('   2. Run: node fix-database-schema.js to fix this');
        } else if (error.code === 'ER_NO_SUCH_TABLE') {
            console.log('⚠️ Table does not exist - please create the required tables');
        } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.log('⚠️ Database access denied - check your credentials');
        }
        
        // Don't throw error to prevent bot crash
        console.log('💡 Bot will continue without storing this message');
    }
}

// Helper function to store message from history sync (without media upload to avoid timeouts)
async function storeHistorySyncMessage(message, sock, sessionId, contacts = []) {
    try {
        if (!sessionId) {
            console.log('⚠️ No session ID provided for storing history sync message');
            return;
        }

        let chatId = message.key?.remoteJid || message.key?.remoteJidAlt;
        if (!chatId) {
            console.log('⚠️ No chat ID found in message');
            return;
        }

        const isGroup = chatId.endsWith('@g.us');

        // Extract sender information
        let fromNumber = 'unknown';
        let senderId = 'unknown';
        let senderName = 'Unknown';  // Default to Unknown, will be overridden

        if (isGroup && message.key.participant) {
            // For groups, use participant info
            fromNumber = message.key.participant.split('@')[0];
            senderId = fromNumber;

            // Try multiple sources to get sender name
            // 1. First check message.pushName (most reliable for history sync)
            if (message.pushName) {
                senderName = message.pushName;
            }
            // 2. Try contacts array from history sync
            if (senderName === 'Unknown') {
                const contact = contacts.find(c => c.id === message.key.participant);
                if (contact?.name) {
                    senderName = contact.name;
                } else if (contact?.notify) {
                    senderName = contact.notify;
                }
            }
            // 3. Try groupMetadata to get participant info (like storeMessageInDatabase)
            if (senderName === 'Unknown' && sock) {
                try {
                    const groupMetadata = await sock.groupMetadata(chatId);
                    const senderParticipant = groupMetadata.participants.find(
                        obj => obj.id === message.key.participant
                    );
                    if (senderParticipant) {
                        if (senderParticipant.name) {
                            senderName = senderParticipant.name;
                        } else if (senderParticipant.verifiedName) {
                            senderName = senderParticipant.verifiedName;
                        } else if (senderParticipant.notify) {
                            senderName = senderParticipant.notify;
                        }
                    }
                } catch (err) {
                    // Group metadata not available, continue with fallback
                }
            }
            // 4. Try onWhatsApp lookup for profile name
            if (senderName === 'Unknown' && sock) {
                try {
                    const [waContact] = await sock.onWhatsApp(message.key.participant);
                    if (waContact?.notify) {
                        senderName = waContact.notify;
                    }
                } catch (err) {
                    // Continue with fallback
                }
            }
            // 5. Final fallback to phone number (not 'Unknown')
            if (senderName === 'Unknown') {
                senderName = fromNumber;
            }
        } else if (!isGroup) {
            if (message.key.fromMe) {
                // Message sent by us
                const sessionData = await database.getDataSession(sessionId);
                fromNumber = sessionData?.phone_number || 'unknown';
                senderId = fromNumber;
                senderName = 'You';  // Mark as sent by user
            } else {
                // Message received from someone else
                const remoteJidAlt = message.key.remoteJidAlt || message.key.senderPn;
                fromNumber = remoteJidAlt ? remoteJidAlt.split('@')[0] : chatId.split('@')[0];
                senderId = fromNumber;

                // Update chatId if we have alternate JID
                if (remoteJidAlt) {
                    chatId = remoteJidAlt;
                }

                // Try multiple sources to get sender name
                // 1. First check message.pushName (most reliable for history sync)
                if (message.pushName) {
                    senderName = message.pushName;
                }
                // 2. Try contacts array from history sync
                else {
                    const contact = contacts.find(c => c.id === message.key.remoteJid || c.id === remoteJidAlt);
                    if (contact?.name) {
                        senderName = contact.name;
                    } else if (contact?.notify) {
                        senderName = contact.notify;
                    }
                }
                // 3. Try socket contacts store
                if (senderName === 'Unknown' && sock) {
                    try {
                        const socketContacts = sock.store?.contacts || {};
                        const lookupJid = remoteJidAlt || message.key.remoteJid;
                        const socketContact = socketContacts[lookupJid];
                        if (socketContact?.name) {
                            senderName = socketContact.name;
                        } else if (socketContact?.notify) {
                            senderName = socketContact.notify;
                        } else if (socketContact?.verifiedName) {
                            senderName = socketContact.verifiedName;
                        }
                    } catch (err) {
                        // Continue with fallback
                    }
                }
                // 4. Try onWhatsApp lookup for profile name
                if (senderName === 'Unknown' && sock) {
                    try {
                        const lookupJid = remoteJidAlt || message.key.remoteJid;
                        const [waContact] = await sock.onWhatsApp(lookupJid);
                        if (waContact?.notify) {
                            senderName = waContact.notify;
                        }
                    } catch (err) {
                        // Continue with fallback
                    }
                }
                // 5. Final fallback to phone number
                if (senderName === 'Unknown') {
                    senderName = fromNumber;
                }
            }
        }

        // Extract message content
        const body = s3Service.extractTextContent(message) || '';
        const mediaType = s3Service.getMediaType(message);
        const hasMedia = mediaType ? 1 : 0;

        // For history sync, we don't upload media to S3 to avoid timeouts
        // Media can be fetched on-demand later
        let mediaPreview = null;
        if (hasMedia) {
            // Store a placeholder indicating media exists but wasn't uploaded during sync
            mediaPreview = `history_sync_media_${mediaType}`;
        }

        const messageData = {
            id: message.key.id,
            chatId: sessionManager.generateChatId(chatId, sessionId),
            sessionId: sessionId,
            fromNumber: fromNumber,
            senderId: senderId,
            senderName: senderName,
            body: body,
            timestamp: Number(message.messageTimestamp),
            fromMe: message.key.fromMe ? 1 : 0,
            hasMedia: hasMedia,
            mediaType: mediaType,
            whatsappMessageId: message.key.id,
            mediaPreview: mediaPreview,
            parentId: message?.message?.extendedTextMessage?.contextInfo?.stanzaId || null,
            status: message.key.fromMe ? 'sent' : 'delivered'
        };

        // Clean undefined values
        const cleanMessageData = {};
        for (const [key, value] of Object.entries(messageData)) {
            cleanMessageData[key] = value === undefined ? null : value;
        }

        await database.createMessage(cleanMessageData);

        // Update chat's last message info
        try {
            await updateChatLastMessage(chatId, message.key.id, Number(message.messageTimestamp), sessionId);
        } catch (error) {
            // Silent fail for last message update
        }

    } catch (error) {
        console.error('❌ Error storing history sync message:', error.message);
        throw error;
    }
}

// Helper function to update chat's last message info
async function updateChatLastMessage(chatId, messageId, timestamp, sessionId) {
    try {
        if (!sessionId) {
            return;
        }

        const dbChatId = sessionManager.generateChatId(chatId,sessionId);
        
        // Update the chat's last message info
        await database.pool.execute(
            'UPDATE chats SET last_message_id = ?, last_message_timestamp = ?, updated_at = NOW() WHERE id = ? AND session_id = ?',
            [messageId, timestamp, dbChatId, sessionId]
        );
        
        console.log(`✅ Updated chat last message: ${chatId} -> ${messageId}`);
    } catch (error) {
        console.error('❌ Error updating chat last message:', error.message);
    }
}

// Function to get and display chat counts with participant information
async function getChatCounts(sock) {
    try {
        const chats = await sock.store?.chats || {};
        const chatArray = Object.values(chats);
        
        const individualChats = chatArray.filter(chat => !chat.id.endsWith('@g.us'));
        const groupChats = chatArray.filter(chat => chat.id.endsWith('@g.us'));
        
        console.log('\n📊 Current Chat Statistics:');
        console.log(`   👤 Individual Chats: ${individualChats.length}`);
        console.log(`   👥 Group Chats: ${groupChats.length}`);
        console.log(`   📱 Total Chats: ${chatArray.length}`);
        console.log('   ─────────────────────────────');
        
        // Display individual chat numbers with participant count (always 2: you + them)
        if (individualChats.length > 0) {
            console.log('\n📞 Individual Chats:');
            individualChats.forEach((chat, index) => {
                const number = chat.id.split('@')[0];
                const name = chat.name || 'Unknown';
                const participants = 2; // Always 2 participants in individual chats (you + them)
                console.log(`   ${index + 1}. ${name} (${number}) - Participants: ${participants}`);
            });
        }
        
        // Display group chat names with participant count
        if (groupChats.length > 0) {
            console.log('\n👥 Group Chats:');
            for (let i = 0; i < groupChats.length; i++) {
                const chat = groupChats[i];
                const name = chat.name || 'Unknown Group';
                
                try {
                    // Get group metadata to fetch participant count
                    const groupMetadata = await sock.groupMetadata(chat.id);
                    const phoneNumbers = groupMetadata.participants.map(p =>
                        p.phoneNumber.replace('@s.whatsapp.net', '')
                      );
                      // fs.writeFileSync('groupMetadata2.json', JSON.stringify(phoneNumbers));
                    const participantCount = groupMetadata.participants ? groupMetadata.participants.length : 0;
                    console.log(`   ${i + 1}. ${name} - Participants: ${participantCount}`);
                    
                    // Optionally display participant numbers (uncomment if you want to see all participants)
                    /*
                    if (groupMetadata.participants && groupMetadata.participants.length > 0) {
                        console.log(`      👥 Members:`);
                        groupMetadata.participants.forEach((participant, pIndex) => {
                            const memberNumber = participant.id.split('@')[0];
                            const isAdmin = participant.admin ? ' (Admin)' : '';
                            console.log(`         ${pIndex + 1}. ${memberNumber}${isAdmin}`);
                        });
                    }
                    */
                } catch (error) {
                    // If we can't get group metadata, show unknown participant count
                    console.log(`   ${i + 1}. ${name} - Participants: Unknown (Error: ${error.message})`);
                }
            }
        }
        
        // Summary of total participants across all chats
        let totalParticipants = individualChats.length * 2; // Individual chats have 2 participants each
        
        // Add group participants
        for (const chat of groupChats) {
            try {
                const groupMetadata = await sock.groupMetadata(chat.id);
                totalParticipants += groupMetadata.participants ? groupMetadata.participants.length : 0;
            } catch (error) {
                // Skip if can't get metadata
            }
        }
        
        console.log('\n🔢 Participant Summary:');
        console.log(`   📊 Total Participants Across All Chats: ${totalParticipants}`);
        console.log(`   👤 Individual Chat Participants: ${individualChats.length * 2}`);
        console.log(`   👥 Group Chat Participants: ${totalParticipants - (individualChats.length * 2)}`);
        
    } catch (error) {
        console.error('Error getting chat counts:', error);
    }
}

// Handle process termination
process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down WhatsApp bot...');
    process.exit(0);
});


// Start Express server
app.listen(PORT, async () => {
    console.log(`🌐 Express server running on port ${PORT}`);
    console.log(`📡 Session endpoint: http://localhost:${PORT}/session/:sessionId`);
    
    // AUTOMATIC SERVER RECOVERY: Restore all ready sessions on startup
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 SERVER STARTUP - AUTOMATIC DATA RECOVERY`);
    console.log(`${'='.repeat(60)}\n`);
    
    try {
        // Restore all previously connected sessions
        await restoreAllReadySessions();
        
        console.log(`${'='.repeat(60)}`);
        console.log(`✅ SERVER READY - All sessions restored and data recovered`);
        console.log(`${'='.repeat(60)}\n`);
    } catch (error) {
        console.error(`❌ Error during server startup recovery:`, error.message);
    }
});

// Function to restore all ready sessions on server startup
async function restoreAllReadySessions() {
    try {
        console.log('🔄 Restoring all ready sessions from database...');
        
        // Get all ready sessions from database
        const readySessions = await database.getAllReadySessions();
        
        if (readySessions.length === 0) {
            console.log('📭 No ready sessions found to restore');
            return;
        }
        
        console.log(`📱 Found ${readySessions.length} ready session(s) to restore\n`);
        
        let successCount = 0;
        let totalChats = 0;
        let totalMessages = 0;
        
        for (const session of readySessions) {
            try {
                console.log(`🔄 Restoring session ${session.id} (${session.phone_number})...`);
                
                // Get data counts for this session BEFORE restoration
                const [chatsBefore] = await database.pool.execute(
                    'SELECT COUNT(*) as count FROM chats WHERE session_id = ?',
                    [session.id]
                );
                const [messagesBefore] = await database.pool.execute(
                    'SELECT COUNT(*) as count FROM messages WHERE session_id = ?',
                    [session.id]
                );
                
                const chatCountBefore = chatsBefore[0].count;
                const messageCountBefore = messagesBefore[0].count;
                
                // Start WhatsApp connection for this session with forced history sync
                // forceHistorySync = true clears sync state, like closing/reopening browser
                await startWhatsAppForSession(session.id, true);
                
                successCount++;
                totalChats += chatCountBefore;
                totalMessages += messageCountBefore;
                
                console.log(`   ✅ Session ${session.id} restored`);
                console.log(`   📂 Chats recovered: ${chatCountBefore}`);
                console.log(`   📨 Messages recovered: ${messageCountBefore}\n`);
                
            } catch (error) {
                console.error(`❌ Error restoring session ${session.id}:`, error.message);
            }
        }
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`✅ SESSION RESTORATION COMPLETED`);
        console.log(`${'='.repeat(60)}`);
        console.log(`   📱 Sessions restored: ${successCount}/${readySessions.length}`);
        console.log(`   📂 Total chats recovered: ${totalChats}`);
        console.log(`   📨 Total messages recovered: ${totalMessages}`);
        console.log(`   💾 All data has been recovered from database`);
        console.log(`   🔄 History sync will automatically recover any messages since last sync`);
        console.log(`${'='.repeat(60)}\n`);
        
    } catch (error) {
        console.error('❌ Error restoring ready sessions:', error.message);
    }
}

// Start the WhatsApp bot
console.log('🚀 WhatsApp Bot Server Started...');
console.log('📱 Create a session using POST /session to generate QR codes\n');

// Example: Convert raw QR data to image (uncomment to test)
// const testQRData = '2@PSZ42LR4Ap/yRLdwqA4E2ef/ns7fXUsauCiTWLXFE1Ke4NSbk7HtA/2N9iQkHLk3jZrXc8JpvyCrrgAXONpOvECAOEFpxqsxHUQ=,A6STEjJNTzhZ5yg4TTZ5cnDepKUtwkAbjPSzZNjxJHU=,E5tSe8rrGBXg2GSDexkfWte2L4OcMia1EHMPKc0r50c=,3OgV9Gzjq+mljWPxgJE16snRS4PJ6NfW5kSqXagRmzA=';
// convertAndDisplayQR(testQRData).then(qrImage => {
//     if (qrImage) {
//         console.log('🎉 QR code conversion successful!');
//         console.log('📊 You can now use this QR image in your application');
//     }
// });

