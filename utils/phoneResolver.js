/**
 * Phone number and JID resolution utilities
 * Handles conversion between phone numbers and WhatsApp JIDs (@s.whatsapp.net and @lid)
 */

/**
 * Extract phone number from any JID format
 * @param {string} jid - WhatsApp JID (can be @s.whatsapp.net, @lid, or @g.us)
 * @returns {string} - Phone number or identifier
 */
function extractPhoneFromJid(jid) {
    if (!jid) return null;
    return jid.split('@')[0];
}

/**
 * Check if JID is a business account (@lid)
 * @param {string} jid - WhatsApp JID
 * @returns {boolean}
 */
function isBusinessAccount(jid) {
    return jid && jid.endsWith('@lid');
}

/**
 * Check if JID is a regular user account
 * @param {string} jid - WhatsApp JID
 * @returns {boolean}
 */
function isRegularAccount(jid) {
    return jid && jid.endsWith('@s.whatsapp.net');
}

/**
 * Check if JID is a group
 * @param {string} jid - WhatsApp JID
 * @returns {boolean}
 */
function isGroup(jid) {
    return jid && jid.endsWith('@g.us');
}

/**
 * Resolve actual phone number from @lid business account
 * @param {object} sock - WhatsApp socket connection
 * @param {string} jid - WhatsApp JID (preferably @lid)
 * @returns {Promise<string|null>} - Actual phone number or null if not found
 */
async function resolvePhoneFromLid(sock, jid) {
    try {
        if (!isBusinessAccount(jid)) {
            // If it's not @lid, just return the extracted number
            return extractPhoneFromJid(jid);
        }

        // Try to resolve using onWhatsApp
        const [result] = await sock.onWhatsApp(jid);

        if (result && result.jid) {
            const actualPhone = extractPhoneFromJid(result.jid);
            console.log(`✅ Resolved @lid ${jid} to phone: ${actualPhone}`);
            return actualPhone;
        }

        // Fallback: return the lid identifier itself
        console.log(`⚠️ Could not resolve @lid ${jid}, using lid as identifier`);
        return extractPhoneFromJid(jid);
    } catch (error) {
        console.error(`❌ Error resolving phone from @lid:`, error.message);
        return extractPhoneFromJid(jid);
    }
}

/**
 * Get phone number from group participant (handles @lid in groups)
 * @param {object} sock - WhatsApp socket connection
 * @param {string} groupJid - Group JID
 * @param {string} participantJid - Participant JID (can be @lid or @s.whatsapp.net)
 * @returns {Promise<string|null>} - Phone number
 */
async function getParticipantPhone(sock, groupJid, participantJid) {
    try {
        // If regular account, extract directly
        if (isRegularAccount(participantJid)) {
            return extractPhoneFromJid(participantJid);
        }

        // If @lid, try to get from group metadata
        const groupMetadata = await sock.groupMetadata(groupJid);
        const participant = groupMetadata.participants.find(p => p.id === participantJid);

        if (participant) {
            // Try to resolve the actual phone
            return await resolvePhoneFromLid(sock, participant.id);
        }

        return extractPhoneFromJid(participantJid);
    } catch (error) {
        console.error(`❌ Error getting participant phone:`, error.message);
        return extractPhoneFromJid(participantJid);
    }
}

/**
 * Convert phone number to JID format for sending messages
 * This tries both @s.whatsapp.net and checks if account exists
 * @param {object} sock - WhatsApp socket connection
 * @param {string} phoneNumber - Phone number (with or without country code)
 * @returns {Promise<string>} - Valid JID for sending messages
 */
async function phoneToJid(sock, phoneNumber) {
    try {
        // Clean phone number (remove spaces, dashes, etc)
        let cleanPhone = phoneNumber.replace(/\D/g, '');

        // Try standard format first
        const standardJid = `${cleanPhone}@s.whatsapp.net`;

        // Check if number exists on WhatsApp
        const result = await sock.onWhatsApp(standardJid);

        if (result && result.length > 0 && result[0].exists) {
            // Return the JID from WhatsApp (might be @lid or @s.whatsapp.net)
            console.log(`✅ Found WhatsApp account for ${cleanPhone}: ${result[0].jid}`);
            return result[0].jid;
        }

        // Fallback: return standard format
        console.log(`⚠️ Using fallback JID format for ${cleanPhone}`);
        return standardJid;
    } catch (error) {
        console.error(`❌ Error converting phone to JID:`, error.message);
        // Fallback to standard format
        const cleanPhone = phoneNumber.replace(/\D/g, '');
        return `${cleanPhone}@s.whatsapp.net`;
    }
}

/**
 * Parse phone_number field (handles JSON array, string, or null)
 * @param {string|array} phoneData - Phone number data from database
 * @returns {array} - Array of phone numbers
 */
function parsePhoneNumbers(phoneData) {
    if (!phoneData) return [];

    // If it's already an array
    if (Array.isArray(phoneData)) {
        return phoneData;
    }

    // If it's a string, try to parse as JSON
    if (typeof phoneData === 'string') {
        try {
            const parsed = JSON.parse(phoneData);
            return Array.isArray(parsed) ? parsed : [phoneData];
        } catch (error) {
            // Not JSON, treat as single phone number
            return [phoneData];
        }
    }

    return [];
}

/**
 * Check if phone number exists in array or string
 * @param {string|array} phoneData - Phone number data from database
 * @param {string} searchPhone - Phone number to search for
 * @returns {boolean}
 */
function phoneExistsInData(phoneData, searchPhone) {
    const phones = parsePhoneNumbers(phoneData);
    const cleanSearch = searchPhone.replace(/\D/g, '');

    return phones.some(phone => {
        const cleanPhone = phone.toString().replace(/\D/g, '');
        return cleanPhone === cleanSearch || cleanPhone.includes(cleanSearch);
    });
}

/**
 * Search for chat by phone number, handling both @lid and regular accounts
 * Supports phone_number stored as JSON array or string
 * @param {object} database - Database instance
 * @param {string} phoneNumber - Phone number to search for
 * @param {number} sessionId - Session ID
 * @returns {Promise<object|null>} - Chat object or null
 */
async function findChatByPhone(database, phoneNumber, sessionId) {
    try {
        // Clean phone number
        const cleanPhone = phoneNumber.replace(/\D/g, '');

        // Try to find chat using database method (supports JSON array)
        const chat = await database.getChatByPhoneNumber(cleanPhone, sessionId);

        if (chat) {
            console.log(`✅ Found chat for phone ${cleanPhone}: ${chat.id}`);
            console.log(`   Phone data in DB:`, chat.phone_number);

            // Parse phone numbers if stored as array
            const phoneNumbers = parsePhoneNumbers(chat.phone_number);
            console.log(`   Parsed phone numbers:`, phoneNumbers);

            return chat;
        }

        console.log(`⚠️ No chat found for phone ${cleanPhone}`);
        return null;
    } catch (error) {
        console.error(`❌ Error finding chat by phone:`, error.message);
        return null;
    }
}

module.exports = {
    extractPhoneFromJid,
    isBusinessAccount,
    isRegularAccount,
    isGroup,
    resolvePhoneFromLid,
    getParticipantPhone,
    phoneToJid,
    findChatByPhone,
    parsePhoneNumbers,
    phoneExistsInData
};
