const { makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Import our services
const database = require('./config/database');
const s3Service = require('./services/s3Service');
const sessionManager = require('./services/sessionManager');
const { log } = require('console');

// Create Express app
const app = express();
const PORT = 3001;

// Middleware
app.use(express.json());

// Store current QR code globally
let currentQRCode = null;

// Store sockets by session ID
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
        res.status(500).json({
            success: false,
            message: 'Internal server error',
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

            await database.createOrUpdateChat({
                id: chatId,
                sessionId,
                name: toJid.split('@')[0],
                phoneNumber: toJid.split('@')[0],
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

// Function to start WhatsApp for a specific session
async function startWhatsAppForSession(sessionId) {
    console.log(`🚀 Starting WhatsApp connection for session: ${sessionId}`);
    
    // Use multi-file auth state for persistent sessions (session-specific)
    const authDir = `auth_info_baileys_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // Don't print QR in terminal for multiple sessions
        defaultQueryTimeoutMs: 60000,
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        syncSessionMessages: true
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
                await database.updateSessionReady(sessionId, phoneNumber);
                console.log(`📱 Session ${sessionId} ready for phone: ${phoneNumber}`);
            } catch (error) {
                console.error(`❌ Error marking session ${sessionId} as ready:`, error.message);
            }
            
            // Set up message listeners for this session
            setupMessageListeners(sock, sessionId);
        }
        
        if (connection === 'close') {
            console.log(`❌ Connection closed for session ${sessionId}`);
            
            // Update session status to not ready
            try {
                await database.pool.execute(
                    'UPDATE sessions SET ready = 0, updated_at = NOW() WHERE id = ?',
                    [sessionId]
                );
            } catch (error) {
                console.error(`❌ Error updating session status for ${sessionId}:`, error.message);
            }
            
            // Check the disconnect reason
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                console.log(`🚫 Session ${sessionId} logged out - not attempting reconnection`);
                // Remove socket from map
                // sessionSockets.delete(sessionId);
                return;
            }
            
            // For all other errors, attempt reconnection
            if (shouldReconnect) {
                console.log(`🔄 Attempting to reconnect session ${sessionId} in 5 seconds...`);
                setTimeout(() => {
                    startWhatsAppForSession(sessionId);
                }, 5000);
            } else {
                // Remove socket from map if not reconnecting
                // sessionSockets.delete(sessionId);
            }
        }
    });


    // Listen for messages
    sock.ev.on('messages.upsert', async (messageUpdate) => {
        const { messages, type } = messageUpdate;

        if (type === 'notify') {
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
        }
    });

    // Listen for messaging history sync
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, syncType }) => {
        console.log("now messaging-history.set")
        return;
        console.log(`⚡ History Sync Event Triggered for session ${sessionId}!`);
        console.log('Sync Type:', syncType);
        console.log('Chats count:', chats.length);
        console.log('Contacts count:', contacts.length);
        console.log('Messages count:', messages.length);

        // Process in background to avoid blocking the main connection
        setImmediate(async () => {
            try {
                // Store synced chats in database
                let index=0;

                for (const chat of chats) {
                    index=index+1;
                    if(index<=20){
                        try {
                            // fs.writeFileSync('0'+index+'.json', JSON.stringify(chat));
                        } catch (fileError) {
                            console.error(`❌ Error writing chat file ${index}:`, fileError.message);
                        }
                    }
                    try {
                        // await storeChatInDatabase(chat, sock, sessionId);
                    } catch (error) {
                        console.error(`❌ Error storing synced chat ${chat.id}:`, error);
                    }
                }

                // Store synced messages in database (skip recent messages to avoid duplicates)
                const currentTime = Date.now();
                const fiveMinutesAgo = currentTime - (5 * 60 * 1000); // 5 minutes ago
                let index2=0;
                for (const message of messages) {
                    index2=index2+1;
                    if(index2<=20){
                        try {
                            // fs.writeFileSync('00'+index+'.json', JSON.stringify(message));
                        } catch (fileError) {
                            console.error(`❌ Error writing message file ${index2}:`, fileError.message);
                        }
                    }
                    try {
                        // Skip messages that are very recent (likely already processed by messages.upsert)
                        const messageTime = Number(message.messageTimestamp) * 1000; // Convert to milliseconds
                        // if (messageTime > fiveMinutesAgo) {
                        //     console.log(`⏭️ Skipping recent message ${message.key.id} from history sync (already processed)`);
                        //     continue;
                        // }
                        let msg=message
                        const remoteJid = msg?.key?.remoteJid; // Fixed: use message.key, not message.message.key
                        const fromMe = msg?.key?.fromMe;

                        // Phone number
                        let phoneNumber = null;
                        if (remoteJid?.endsWith('@s.whatsapp.net')) {
                            phoneNumber = remoteJid.split('@')[0]; // normal user
                        } else if (remoteJid?.endsWith('@lid')) {
                            phoneNumber = remoteJid.split('@')[0]; // business multi-device lid
                        } else if (remoteJid?.endsWith('@g.us')) {
                            phoneNumber = remoteJid; // group
                        }

                        // Find contact name from `contacts` array (NO network calls to prevent timeout)
                        const contact = contacts.find(c => c.id === remoteJid);
                        
                        const name = contact?.name || contact?.notify || phoneNumber;

                        console.log('reeeeeeeeeeeeeeeeesssssssssssssuuuulllllllt')

                        console.log(JSON.stringify({
                            remoteJid: remoteJid,
                            phoneNumber: phoneNumber,
                            contactName: name,
                            fromMe: fromMe
                        }));

                       // await storeMessageInDatabase(message, sock, sessionId);
                    } catch (error) {
                        console.error(`❌ Error storing synced message ${message.key?.id}:`, error);
                    }
                }

                console.log(`✅ History sync completed and stored in database for session ${sessionId}`);
            } catch (error) {
                console.error(`❌ Error in background history sync processing:`, error.message);
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
        syncSessionMessages :true
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
            
            // Trigger messaging-history.set event to sync all data
            console.log('🔄 Triggering messaging-history.set event...');
            try {
                // Manually trigger the history sync by calling the event handler
                const chats = Object.values(sock.store?.chats || {});
                const contacts = Object.values(sock.store?.contacts || {});
                const messages = Object.values(sock.store?.messages || {});
                
                // Flatten messages from all chats
                const allMessages = [];
                for (const chatId in sock.store?.messages || {}) {
                    const chatMessages = Object.values(sock.store.messages[chatId] || {});
                    allMessages.push(...chatMessages);
                }
                
                console.log(`📊 Found ${chats.length} chats, ${contacts.length} contacts, ${allMessages.length} messages`);
                
                // Call the messaging-history.set event handler manually
                await sock.ev.emit('messaging-history.set', {
                    chats: chats,
                    contacts: contacts,
                    messages: allMessages,
                    syncType: 'manual_trigger'
                });

                console.log("now messaging-history.set")
                return;
                
                console.log('✅ Messaging history sync triggered successfully');
            } catch (error) {
                console.error('❌ Error triggering messaging-history.set:', error);
            }
            
            // Update last sync time
            lastSyncTime = Date.now();
            
            // Get initial chat count
            getChatCounts(sock);
            
            // Show initial message tracker status
            setTimeout(() => {
                console.log('📊 Message status tracking is active');
            }, 2000);
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
        
        if (type === 'notify') {
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
        const existingChat = await database.getChat(sessionManager.generateChatId(chatId,sessionId), sessionId);
        if (existingChat) {
            console.log(`✅ Chat already exists in database: ${chatId}`);
            return;
        }

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
            // For individual chats
            chatName =chatId.split('@')[0] ||  message.pushName ;
            phoneNumbers = [chatId.split('@')[0]];
        }

        // Create chat data
        let phoneNumberString;
        if (isGroup) {
            // For groups, store first 3 numbers to fit in VARCHAR(255)
            phoneNumberString = phoneNumbers.slice(0, 3).join(',');
            phoneNumberString = '['+phoneNumberString+']';
    
        } else {
            // For individual chats, store just the one number
            phoneNumberString = phoneNumbers[0] || 'unknown';
            phoneNumberString = '['+phoneNumberString+']';
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
        let chatName = chat.name || chat.subject || 'Unknown';

        if (isGroup) {
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
            // For individual chats, get the other person's number
            phoneNumbers = [chat.id.split('@')[0]];
        }

        // For individual chats, store just the phone number
        // For groups, store the first few numbers (due to VARCHAR(255) limit)
        let phoneNumberString;
        if (isGroup) {
            // For groups, store first 3 numbers to fit in VARCHAR(255)
            phoneNumberString = phoneNumbers.slice(0, 3).join(',');
            phoneNumberString = '['+phoneNumberString+']';
        } else {
            // For individual chats, store just the one number
            phoneNumberString = phoneNumbers[0] || 'unknown';
            phoneNumberString = '['+phoneNumbers[0]+']';
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

        const chatId = message.key.remoteJid;
        const isGroup = chatId.endsWith('@g.us');
        
        // Extract sender information
        let fromNumber = 'unknown';
        let senderId = 'unknown';
        let senderName = message.pushName || 'Unknown';

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
                } else {
                    // Fallback if participant not found
                    fromNumber = message.key.participant.split('@')[0];
                    senderId = fromNumber;
                }
            } catch (error) {
                console.error('❌ Error getting group metadata for message:', error.message);
                // Fallback to basic extraction
                fromNumber = message.key.participant.split('@')[0];
                senderId = fromNumber;
            }
        }
        else if (!isGroup) {
            if(message.key.fromMe){
                const sessionData = await database.getDataSession(sessionId);
                fromNumber = sessionData?.phone_number || 'unknown';
                console.log('bgd a7a ')
                console.log(sessionId)
                console.log(fromNumber)
                senderId = fromNumber;
                // fs.writeFileSync('0.json', JSON.stringify(sessionData, null, 2));
            }
            else{
                console.log("rrrrrrrrrrrrrrrrrrrrrrrrrrrrrr")
                // fromNumber = message.key.remoteJidAlt.split('@')[0];
                fromNumber = message.key.remoteJidAlt.split('@')[0] || message.key.senderPn?.split('@')[0];
                senderId = fromNumber;
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
            status: 'sent'
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

// Function to sync missed messages when server reconnects
async function syncMissedMessages(sock) {
    try {
        console.log('🔄 Starting missed messages sync...');
        
        // Get all chats to check for missed messages
        const chats = await sock.store?.chats || {};
        const chatArray = Object.values(chats);
        
        let totalMissedMessages = 0;
        
        for (const chat of chatArray) {
            try {
                // Get messages from the last sync time
                const messages = await sock.store?.messages?.[chat.id] || {};
                const messageArray = Object.values(messages);
                
                // Filter messages that are newer than last sync time
                const missedMessages = messageArray.filter(msg => {
                    const messageTime = Number(msg.messageTimestamp) * 1000;
                    return messageTime > lastSyncTime;
                });
                
                if (missedMessages.length > 0) {
                    console.log(`📬 Found ${missedMessages.length} missed messages in chat: ${chat.id}`);
                    
                    // Store missed messages in database
                    for (const message of missedMessages) {
                        try {
                            await storeMessageInDatabase(message, sock);
                            totalMissedMessages++;
                        } catch (error) {
                            console.error(`❌ Error storing missed message ${message.key.id}:`, error);
                        }
                    }
                }
            } catch (error) {
                console.error(`❌ Error syncing messages for chat ${chat.id}:`, error);
            }
        }
        
        console.log(`✅ Missed messages sync completed. Found and stored ${totalMissedMessages} missed messages.`);
        
    } catch (error) {
        console.error('❌ Error during missed messages sync:', error);
    }
}

// Handle process termination
process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down WhatsApp bot...');
    process.exit(0);
});


// Start Express server
app.listen(PORT, () => {
    console.log(`🌐 Express server running on port ${PORT}`);
    console.log(`📡 Session endpoint: http://localhost:${PORT}/session/:sessionId`);
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
        
        console.log(`📱 Found ${readySessions.length} ready session(s) to restore`);
        
        for (const session of readySessions) {
            try {
                console.log(`🔄 Restoring session ${session.id} (${session.phone_number})...`);
                
                // Start WhatsApp connection for this session
                await startWhatsAppForSession(session.id);
                
                console.log(`✅ Session ${session.id} restored successfully`);
                
            } catch (error) {
                console.error(`❌ Error restoring session ${session.id}:`, error.message);
            }
        }
        
        console.log('✅ All ready sessions restoration completed');
        
    } catch (error) {
        console.error('❌ Error restoring ready sessions:', error.message);
    }
}

// Start the WhatsApp bot
console.log('🚀 WhatsApp Bot Server Started...');
console.log('📱 Create a session using POST /session to generate QR codes\n');

// Restore all ready sessions on startup
restoreAllReadySessions().then(() => {
    console.log('🔄 Session restoration process completed');
}).catch(error => {
    console.error('❌ Error during session restoration:', error);
});

// Example: Convert raw QR data to image (uncomment to test)
// const testQRData = '2@PSZ42LR4Ap/yRLdwqA4E2ef/ns7fXUsauCiTWLXFE1Ke4NSbk7HtA/2N9iQkHLk3jZrXc8JpvyCrrgAXONpOvECAOEFpxqsxHUQ=,A6STEjJNTzhZ5yg4TTZ5cnDepKUtwkAbjPSzZNjxJHU=,E5tSe8rrGBXg2GSDexkfWte2L4OcMia1EHMPKc0r50c=,3OgV9Gzjq+mljWPxgJE16snRS4PJ6NfW5kSqXagRmzA=';
// convertAndDisplayQR(testQRData).then(qrImage => {
//     if (qrImage) {
//         console.log('🎉 QR code conversion successful!');
//         console.log('📊 You can now use this QR image in your application');
//     }
// });

