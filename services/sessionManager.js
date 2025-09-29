const database = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const QRCode = require("qrcode");

class SessionManager {
    constructor() {
        this.currentSessionId = null;
        this.currentPhoneNumber = null;
    }

    // Initialize session with QR code
    async initializeSession(qrCode) {
        try {
            console.log('🔄 Creating new session in database...');
            this.currentSessionId = await database.createSession(this.convertRawQRToImage(qrCode));
            console.log(`✅ Session created with ID: ${this.currentSessionId}`);
            return this.currentSessionId;
        } catch (error) {
            console.error('❌ Error creating session:', error);
            throw error;
        }
    }

    // Update session QR code
    async updateSessionQR(sessionId, qrCode) {
        try {
            console.log(`🔄 Updating QR code for session ${sessionId}`);
            console.log(`🔍 QR code length: ${qrCode ? qrCode.length : 'null'}`);
            console.log(`🔍 QR code preview: ${qrCode ? qrCode.substring(0, 50) + '...' : 'null'}`);
            
            await database.updateSessionQR(sessionId, qrCode);
            console.log(`✅ QR code updated for session ${sessionId}`);
            
            // Verify the update
            const updatedSession = await database.getSession(sessionId);
            console.log(`🔍 Verification - QR in DB: ${updatedSession.qr ? 'Present (' + updatedSession.qr.length + ' chars)' : 'Empty'}`);
        } catch (error) {
            console.error('❌ Error updating session QR code:', error);
            console.error('❌ Error stack:', error.stack);
            throw error;
        }
    }

    // Mark session as ready when QR is scanned
    async markSessionReady(phoneNumber) {
        try {
            if (!this.currentSessionId) {
                console.log('⚠️ No active session to mark as ready');
                return;
            }

            console.log(`🔄 Marking session ${this.currentSessionId} as ready for phone: ${phoneNumber}`);
            await database.updateSessionReady(this.currentSessionId, phoneNumber);
            this.currentPhoneNumber = phoneNumber;
            console.log(`✅ Session ${this.currentSessionId} marked as ready`);
        } catch (error) {
            console.error('❌ Error marking session as ready:', error);
            throw error;
        }
    }

    // Set current session ID
    setCurrentSessionId(sessionId) {
        this.currentSessionId = sessionId;
        console.log(`📱 Set current session ID: ${sessionId}`);
    }

    // Get current session info
    getCurrentSession() {
        return {
            sessionId: this.currentSessionId,
            phoneNumber: this.currentPhoneNumber
        };
    }

    // Load existing active session
    async loadActiveSession() {
        try {
            const activeSession = await database.getActiveSession();
            if (activeSession) {
                this.currentSessionId = activeSession.id;
                this.currentPhoneNumber = activeSession.phone_number;
                console.log(`📱 Loaded active session: ${this.currentSessionId} (${this.currentPhoneNumber})`);
                return activeSession;
            }
            return null;
        } catch (error) {
            console.error('❌ Error loading active session:', error);
            return null;
        }
    }

    // Check if session is ready
    isSessionReady() {
        return this.currentSessionId && this.currentPhoneNumber;
    }

    // Generate unique message ID
    generateMessageId() {
        return uuidv4();
    }

    // Generate unique chat ID for database
    generateChatId(whatsappChatId,session_id) {
        return `${whatsappChatId}_${session_id}`;
    }

     convertRawQRToImage(rawQRData) {
        try {
            console.log(`🔄 Converting raw QR data to image...`);
            console.log(`🔍 Raw QR data: ${rawQRData.substring(0, 50)}...`);

            const qrImageBase64 =  QRCode.toDataURL(rawQRData, {
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

}

module.exports = new SessionManager();
