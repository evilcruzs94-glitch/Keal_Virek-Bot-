const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage,
    WAMessageStubType
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const http = require("http");

// ==================== SIMPLE HTTP SERVER FOR RENDER ====================
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Keal_Virek Bot is active 24/7!\n");
}).listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

// ==================== CONFIGURATION ====================
const BOT_NAME = "Keal_Virek";
const BOT_PREFIX = "!";
const OWNER_NUMBER = "2348154465978"; 
const OWNER_JID = OWNER_NUMBER + "@s.whatsapp.net";

const allowedUsers = [OWNER_NUMBER]; 

// ==================== IN-MEMORY STORES ====================
const antilinkGroups = new Set();
const userWarnings = new Map();
const messageStore = new Map();
const mutedUsers = new Set(); // Stores JIDs of globally locked/stealth-restricted or group-muted entities
const pendingApprovals = new Map(); 
let lastPendingId = null; 
let isPublicMode = true; // Tracks public/private state

// ==================== FUN COMMAND ARRAYS ====================
const TRUTHS = [
    "What is your biggest secret that nobody in this group knows?",
    "Have you ever lied to get out of a bad date?",
    "What is the most embarrassing thing you've ever done?",
    "Who was your first crush?",
    "What is your biggest fear in life?"
];

const DARES = [
    "Send a voice message singing a song for 15 seconds.",
    "Change your WhatsApp profile picture to a funny meme for 1 hour.",
    "Send the last photo in your gallery to this chat.",
    "Text your crush and send a screenshot of the message here.",
    "Type using only your nose for the next 3 messages."
];

const EIGHT_BALL_RESPONSES = [
    "Yes, definitely! ✨",
    "It is certain. 👍",
    "Without a doubt. 💯",
    "Ask again later. ⏳",
    "Better not tell you now. 🤐",
    "My sources say no. ❌",
    "Outlook not so good. 📉",
    "Very doubtful. 🚫"
];

// ==================== UTILITY FUNCTIONS ====================
function extractDigits(jid = "") {
    return jid.split("@")[0].split(":")[0].replace(/\D/g, "");
}

function parseDuration(durationStr) {
    if (!durationStr) return 0;
    const cleanStr = durationStr.replace(/[^0-9smhd]/gi, '');
    const match = cleanStr.match(/^(\d+)([smhd])$/i);
    if (!match) return 0;
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
        default: return 0;
    }
}

// ==================== EXECUTION HANDLER FOR APPROVED ACTIONS ====================
async function executeApprovedAction(sockInstance, actionData) {
    if (actionData.type === "warn") {
        const targetDigits = extractDigits(actionData.targetJid);
        const count = (userWarnings.get(actionData.targetJid) || 0) + 1;
        userWarnings.set(actionData.targetJid, count);

        if (count >= 3) {
            userWarnings.delete(actionData.targetJid);
            await sockInstance.groupParticipantsUpdate(actionData.remoteJid, [actionData.targetJid], "remove");
            await sockInstance.sendMessage(actionData.remoteJid, { 
                text: `✅ *PERMISSION GRANTED: WARN & KICK*\n\n🚨 User @${targetDigits} reached 3 warnings and was kicked.\n📝 Reason: ${actionData.reason}`, 
                mentions: [actionData.targetJid] 
            });
        } else {
            await sockInstance.sendMessage(actionData.remoteJid, { 
                text: `✅ *PERMISSION GRANTED: WARNING ISSUED*\n\n⚠️ Warning issued to @${targetDigits} (${count}/3 strikes).\n📝 Reason: ${actionData.reason}`, 
                mentions: [actionData.targetJid] 
            });
        }
    } else if (actionData.type === "mute" || actionData.type === "timeout") {
        const muteKey = `${actionData.remoteJid}_${actionData.targetJid}`;
        mutedUsers.add(muteKey); 
        await sockInstance.sendMessage(actionData.remoteJid, { 
            text: `✅ *PERMISSION GRANTED: USER ${actionData.type.toUpperCase()}D*\n\n👤 User: @${extractDigits(actionData.targetJid)}\n⏳ Duration: ${actionData.durationStr}\n📝 Reason: ${actionData.reason}`, 
            mentions: [actionData.targetJid] 
        });

        setTimeout(async () => {
            if (mutedUsers.has(muteKey)) {
                mutedUsers.delete(muteKey);
                await sockInstance.sendMessage(actionData.remoteJid, { text: `🔊 Timeout expired for @${extractDigits(actionData.targetJid)}. Messages will no longer be deleted.`, mentions: [actionData.targetJid] });
            }
        }, actionData.durationMs);
    } else if (actionData.type === "kick" || actionData.type === "ban") {
        await sockInstance.groupParticipantsUpdate(actionData.remoteJid, [actionData.targetJid], "remove");
        await sockInstance.sendMessage(actionData.remoteJid, { 
            text: `✅ *PERMISSION GRANTED: USER KICKED/BANNED*\n\n👤 User: @${extractDigits(actionData.targetJid)}\n📝 Reason: ${actionData.reason}`, 
            mentions: [actionData.targetJid] 
        });
    } else if (actionData.type === "locknumber") {
        mutedUsers.add(actionData.targetJid);
        await sockInstance.sendMessage(actionData.remoteJid, { 
            text: `✅ *PERMISSION GRANTED: USER SILENTLY LOCKED GLOBALLY*\n\n👤 Number: +${actionData.cleanNumber}\n⏳ Duration: ${actionData.durationStr}\n📝 Reason: ${actionData.reason}\n\n_Every message sent anywhere (groups & DMs) by this user will be instantly deleted by the bot._` 
        });

        setTimeout(async () => {
            if (mutedUsers.has(actionData.targetJid)) {
                mutedUsers.delete(actionData.targetJid);
                console.log(`🔓 Stealth lock expired for: +${actionData.cleanNumber}`);
            }
        }, actionData.durationMs);
    } else if (actionData.type === "unlocknumber") {
        mutedUsers.delete(actionData.targetJid);
        await sockInstance.sendMessage(actionData.remoteJid, { 
            text: `✅ *PERMISSION GRANTED: UNLOCKED*\n\n🔓 Successfully removed the global stealth lock from +${actionData.cleanNumber}. They can now message normally again.` 
        });
    } else if (actionData.type === "unmute") {
        const muteKey = `${actionData.remoteJid}_${actionData.targetJid}`;
        mutedUsers.delete(muteKey);
        await sockInstance.sendMessage(actionData.remoteJid, { 
            text: `✅ *PERMISSION GRANTED: UNMUTED*\n\n🔊 Unmuted @${extractDigits(actionData.targetJid)}`, 
            mentions: [actionData.targetJid] 
        });
    }
}

// ==================== MAIN BOT ENGINE ====================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "error" })
    });

    sock.ev.on("creds.update", saveCreds);

    let codeRequested = false;

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("⚠️ Connection closed. Reconnecting...");
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("\n====================================");
            console.log(`🤖 ${BOT_NAME} IS ONLINE & ACTIVE!`);
            console.log("====================================\n");
        }

        if (!sock.authState.creds.registered && !codeRequested) {
            codeRequested = true;
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(OWNER_NUMBER);
                    console.log(`\n====================================`);
                    console.log(`YOUR PAIRING CODE: ${code}`);
                    console.log(`====================================\n`);
                } catch (err) {
                    console.error("Failed to request pairing code:", err);
                    codeRequested = false;
                }
            }, 3000);
        }
    });

    // GROUP PARTICIPANT WELCOME ENGINE
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action } = update;
        if (action === "add") {
            for (const user of participants) {
                const userDigits = extractDigits(user);
                await sock.sendMessage(id, { 
                    text: `👋 Welcome @${userDigits} to the group! Make sure to read the description and enjoy your stay. 🎉`, 
                    mentions: [user] 
                });
            }
        }
    });

    // MESSAGE INCOMING ENGINE
    sock.ev.on("messages.upsert", async (m) => {
        try {
            if (m.type !== "notify") return;
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            if (msg.key?.id) {
                messageStore.set(msg.key.id, msg);
                if (messageStore.size > 500) {
                    const firstKey = messageStore.keys().next().value;
                    messageStore.delete(firstKey);
                }
            }

            const remoteJid = msg.key.remoteJid;
            if (remoteJid === "status@broadcast") return;

            const isGroup = remoteJid.endsWith("@g.us");
            const isFromMe = msg.key.fromMe;
            const senderJid = isFromMe ? sock.user.id : (msg.key.participant || remoteJid);
            const senderDigits = extractDigits(senderJid);
            const senderName = msg.pushName || senderDigits;

            // CHECK GLOBAL STEALTH LOCK OR GROUP-SPECIFIC MUTE/TIMEOUT
            const groupMuteKey = `${remoteJid}_${senderJid}`;
            if (mutedUsers.has(senderJid) || mutedUsers.has(groupMuteKey)) {
                try {
                    await sock.sendMessage(remoteJid, { delete: msg.key });
                } catch (e) {}
                return;
            }

            const messageType = Object.keys(msg.message)[0];
            let text = msg.message.conversation 
                || msg.message.extendedTextMessage?.text 
                || msg.message.imageMessage?.caption 
                || msg.message.videoMessage?.caption 
                || "";

            console.log(`\n📩 [${BOT_NAME}] Name: ${senderName} (${senderDigits}) | Location: ${isGroup ? 'Group' : 'DM'}\n💬 Message: ${text || messageType}\n------------------------------------`);

            const isOwner = isFromMe || senderDigits === OWNER_NUMBER || senderDigits === extractDigits(sock.user?.id);

            // ==================== ROBUST APPROVAL & DECLINE HANDLER ====================
            const quotedContext = msg.message?.extendedTextMessage?.contextInfo;
            const quotedMsgId = quotedContext?.stanzaId;

            if (isOwner) {
                const textLower = text.toLowerCase().trim();
                let targetApprovalId = null;

                if (quotedMsgId && pendingApprovals.has(quotedMsgId)) {
                    targetApprovalId = quotedMsgId;
                } else if ((textLower === 'approve' || textLower === 'yes' || textLower === 'grant' || textLower === 'decline' || textLower === 'no' || textLower === 'reject') && lastPendingId && pendingApprovals.has(lastPendingId)) {
                    targetApprovalId = lastPendingId;
                }

                if (targetApprovalId) {
                    const isDeclineAction = textLower.includes('decline') || textLower.includes('no') || textLower.includes('reject');
                    const isApproveAction = textLower.includes('approve') || textLower.includes('yes') || textLower.includes('grant');

                    if (isDeclineAction) {
                        const actionData = pendingApprovals.get(targetApprovalId);
                        pendingApprovals.delete(targetApprovalId);
                        if (lastPendingId === targetApprovalId) lastPendingId = null;

                        await sock.sendMessage(actionData.remoteJid, { 
                            text: `❌ *ACTION DECLINED*\n\n🚫 Promise Henry [KEAL_VIREK] declined the request to *${actionData.type.toUpperCase()}* user @${extractDigits(actionData.targetJid) || actionData.cleanNumber || ''}.`, 
                            mentions: actionData.targetJid ? [actionData.targetJid] : [] 
                        });
                        await sock.sendMessage(remoteJid, { text: `❌ *Action Declined Successfully!*` }, { quoted: msg });
                        return;
                    } else if (isApproveAction) {
                        const actionData = pendingApprovals.get(targetApprovalId);
                        pendingApprovals.delete(targetApprovalId);
                        if (lastPendingId === targetApprovalId) lastPendingId = null;

                        await executeApprovedAction(sock, actionData);
                        await sock.sendMessage(remoteJid, { text: `✅ *Action Granted & Executed Successfully!*` }, { quoted: msg });
                        return;
                    }
                }
            }

            // ==================== UNIVERSAL VIEW-ONCE SNIFFER ====================
            const isViewOnce = messageType === "viewOnceMessage" || messageType === "viewOnceMessageV2" || messageType === "viewOnceMessageV2Extension";
            if (isViewOnce) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                    const innerMsg = msg.message[messageType].message;
                    const mediaType = Object.keys(innerMsg)[0];

                    if (mediaType === "imageMessage") {
                        await sock.sendMessage(remoteJid, { image: buffer, caption: `🔓 *REVEALED VIEW-ONCE IMAGE*` }, { quoted: msg });
                    } else if (mediaType === "videoMessage") {
                        await sock.sendMessage(remoteJid, { video: buffer, caption: `🔓 *REVEALED VIEW-ONCE VIDEO*` }, { quoted: msg });
                    } else if (mediaType === "audioMessage") {
                        await sock.sendMessage(remoteJid, { audio: buffer, mimetype: 'audio/mp4', ptt: true }, { quoted: msg });
                    }
                } catch (err) {
                    console.error("❌ Failed view-once reveal:", err.message);
                }
            }

            // AUTOMATIC ANTILINK PROTECTION
            if (isGroup && antilinkGroups.has(remoteJid) && !isFromMe) {
                const linkRegex = /(chat\.whatsapp\.com\/[A-Za-z0-9]|https?:\/\/[^\s]+)/gi;
                if (linkRegex.test(text)) {
                    const groupMetadata = await sock.groupMetadata(remoteJid);
                    const groupAdmins = groupMetadata.participants.filter(p => p.admin !== null).map(p => p.id);
                    const botJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";

                    if (groupAdmins.includes(botJid) && !groupAdmins.includes(senderJid)) {
                        await sock.sendMessage(remoteJid, { delete: msg.key });
                        await sock.groupParticipantsUpdate(remoteJid, [senderJid], "remove");
                        await sock.sendMessage(remoteJid, { text: `🚨 *ANTILINK TRIGGERED:* Removed @${senderDigits} for posting links.`, mentions: [senderJid] });
                        return;
                    }
                }
            }

            if (!text.startsWith(BOT_PREFIX)) return;

            let cleanText = text.slice(BOT_PREFIX.length).trim();
            if (cleanText.startsWith("8 ball")) cleanText = "8ball " + cleanText.slice(6).trim();

            const args = cleanText.split(/ +/);
            const command = args.shift().toLowerCase();
            const mentioned = quotedContext?.mentionedJid || [];
            const quotedSender = quotedContext?.participant;

            const validCommands = [
                "menu", "start", "hi", "hello", "help", "stop", "unsubscribe", 
                "agent", "human", "status", "book", "order", "track", "language", 
                "cancel", "owner", "hack", "mode", "grant", "decline", "block", 
                "unblock", "antilink", "warn", "mute", "timeout", "kick", "ban", 
                "unmute", "clearchat", "truth", "dare", "ship", "roll", "dice", 
                "coin", "flip", "8ball", "sticker", "s", "ai", "ping", "check", 
                "locknumber", "unlocknumber", "listmuted", "listlocks", "warnings", "statusall"
            ];

            // ==================== COMMAND SWITCH ====================
            switch (command) {
                case "menu": {
                    const menuOptions = `📋 *${BOT_NAME} OPTIONS MENU* 📋\n\n` +
                        `- \`!menu\` — show options\n` +
                        `- \`!start\` / \`!hi\` / \`!hello\` — start or restart the bot\n` +
                        `- \`!help\` — show help menu\n` +
                        `- \`!stop\` / \`!unsubscribe\` — opt out\n` +
                        `- \`!agent\` / \`!human\` — talk to a human\n` +
                        `- \`!status\` — check order/ticket status\n` +
                        `- \`!book\` / \`!order\` / \`!track\` — common business actions\n` +
                        `- \`!language\` — change language\n` +
                        `- \`!cancel\` — cancel an action\n` +
                        `- \`!check <number>\` — look up a WhatsApp number\n` +
                        `- \`!locknumber <number> <duration> <reason>\` — silently lock a number globally (Approval Required)\n` +
                        `- \`!unlocknumber <number>\` — remove global stealth lock (Approval Required)\n\n` +
                        `🛡️ *Moderation (Approval Required):* \`!antilink\`, \`!warn\`, \`!timeout\`, \`!mute\`, \`!kick\`, \`!ban\`, \`!unmute\`\n` +
                        `🔍 *Inspection Tools:* \`!listmuted\`, \`!listlocks\`, \`!warnings\`, \`!statusall\`\n` +
                        `🎮 *Games:* \`!truth\`, \`!dare\`, \`!ship\`, \`!8ball\`, \`!coin\`, \`!roll\``;
                    await sock.sendMessage(remoteJid, { text: menuOptions }, { quoted: msg });
                    break;
                }

                case "start":
                case "hi":
                case "hello": {
                    await sock.sendMessage(remoteJid, { text: `🤖 Hello! Welcome back to ${BOT_NAME}. Type \`!menu\` to see available options.` }, { quoted: msg });
                    break;
                }

                case "help": {
                    const helpText = `🤖 *${BOT_NAME} HELP CENTER* 🤖\n\n` +
                        `Type \`!menu\` to view all quick options and commands available for interaction.`;
                    await sock.sendMessage(remoteJid, { text: helpText }, { quoted: msg });
                    break;
                }

                case "stop":
                case "unsubscribe": {
                    await sock.sendMessage(remoteJid, { text: `🔕 You have successfully opted out / unsubscribed from automated messages.` }, { quoted: msg });
                    break;
                }

                case "agent":
                case "human": {
                    await sock.sendMessage(remoteJid, { text: `👤 Connecting you to a human agent. Please hold on while someone reviews your request.` }, { quoted: msg });
                    
                    let chatLocation = isGroup ? `Group (${remoteJid})` : "Direct Message";
                    await sock.sendMessage(OWNER_JID, { 
                        text: `🚨 *HUMAN AGENT REQUESTED!*\n\n👤 User Name: ${senderName}\n📞 Number: wa.me/${senderDigits}\n📍 From: ${chatLocation}\n\n_Click the number link above to message them directly!_`,
                        mentions: [senderJid]
                    });
                    break;
                }

                case "status": {
                    await sock.sendMessage(remoteJid, { text: `🔍 *Order/Ticket Status:* No active orders or tickets found for your account.` }, { quoted: msg });
                    break;
                }

                case "book":
                case "order":
                case "track": {
                    await sock.sendMessage(remoteJid, { text: `📦 Business action triggered. Please provide your reference number or details to proceed.` }, { quoted: msg });
                    break;
                }

                case "language": {
                    await sock.sendMessage(remoteJid, { text: `🌐 Language settings: Current language is set to English (default).` }, { quoted: msg });
                    break;
                }

                case "cancel": {
                    await sock.sendMessage(remoteJid, { text: `❌ Current action has been cancelled successfully.` }, { quoted: msg });
                    break;
                }

                case "owner": {
                    await sock.sendMessage(remoteJid, { text: `👑 *Bot Owner:* Promise Henry [KEAL_VIREK]\n📞 Number: wa.me/${OWNER_NUMBER}` }, { quoted: msg });
                    break;
                }

                case "hack": {
                    await sock.sendMessage(remoteJid, { text: `💻 Hacking simulation initiated...\n█ 20% [████░░░░░░]\n█ 50% [████████░░]\n█ 100% [██████████] Done! System successfully bypassed. 😂` }, { quoted: msg });
                    break;
                }

                case "mode": {
                    const modeType = args[0]?.toLowerCase();
                    if (!modeType) {
                        const currentStatus = isPublicMode ? "PUBLIC 🌍" : "PRIVATE 🔒";
                        await sock.sendMessage(remoteJid, { text: `⚙️ Current bot mode is: *${currentStatus}*\n\nUsage to switch: \`!mode public\` or \`!mode private\`` }, { quoted: msg });
                    } else {
                        if (modeType === "public") {
                            isPublicMode = true;
                            await sock.sendMessage(remoteJid, { text: `⚙️ Bot mode successfully switched to *PUBLIC 🌍*.` }, { quoted: msg });
                        } else if (modeType === "private") {
                            isPublicMode = false;
                            await sock.sendMessage(remoteJid, { text: `⚙️ Bot mode successfully switched to *PRIVATE 🔒*.` }, { quoted: msg });
                        } else {
                            await sock.sendMessage(remoteJid, { text: `⚠️ Invalid mode. Use \`!mode public\` or \`!mode private\`.` }, { quoted: msg });
                        }
                    }
                    break;
                }

                case "grant": {
                    if (!isOwner) return sock.sendMessage(remoteJid, { text: "⚠️ Only Promise Henry [KEAL_VIREK] can use this command." }, { quoted: msg });
                    if (lastPendingId && pendingApprovals.has(lastPendingId)) {
                        const actionData = pendingApprovals.get(lastPendingId);
                        pendingApprovals.delete(lastPendingId);
                        lastPendingId = null;

                        await executeApprovedAction(sock, actionData);
                        await sock.sendMessage(remoteJid, { text: `✅ *Action Granted & Executed Successfully!*` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: `⚠️ No pending actions waiting for approval right now.` }, { quoted: msg });
                    }
                    break;
                }

                case "decline": {
                    if (!isOwner) return sock.sendMessage(remoteJid, { text: "⚠️ Only Promise Henry [KEAL_VIREK] can use this command." }, { quoted: msg });
                    if (lastPendingId && pendingApprovals.has(lastPendingId)) {
                        const actionData = pendingApprovals.get(lastPendingId);
                        pendingApprovals.delete(lastPendingId);
                        lastPendingId = null;

                        await sock.sendMessage(actionData.remoteJid, { 
                            text: `❌ *ACTION DECLINED*\n\n🚫 Promise Henry [KEAL_VIREK] declined the request to *${actionData.type.toUpperCase()}* user @${extractDigits(actionData.targetJid) || actionData.cleanNumber || ''}.`, 
                            mentions: actionData.targetJid ? [actionData.targetJid] : [] 
                        });
                        await sock.sendMessage(remoteJid, { text: `❌ *Action Declined Successfully!*` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: `⚠️ No pending actions waiting to be declined right now.` }, { quoted: msg });
                    }
                    break;
                }

                case "block": {
                    if (!isOwner) return sock.sendMessage(remoteJid, { text: "⚠️ Only Promise Henry [KEAL_VIREK] can block users." }, { quoted: msg });
                    const targetJid = mentioned[0] || quotedSender || (args[0] ? args[0].replace(/\D/g, "") + "@s.whatsapp.net" : null);
                    if (!targetJid) return sock.sendMessage(remoteJid, { text: "⚠️ Tag, reply, or provide the number of the user to block." }, { quoted: msg });
                    
                    try {
                        await sock.updateBlockStatus(targetJid, "block");
                        await sock.sendMessage(remoteJid, { text: `🚫 Successfully blocked @${extractDigits(targetJid)}`, mentions: [targetJid] }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, { text: `❌ Failed to block user: ${err.message}` }, { quoted: msg });
                    }
                    break;
                }

                case "unblock": {
                    if (!isOwner) return sock.sendMessage(remoteJid, { text: "⚠️ Only Promise Henry [KEAL_VIREK] can unblock users." }, { quoted: msg });
                    const targetJid = mentioned[0] || quotedSender || (args[0] ? args[0].replace(/\D/g, "") + "@s.whatsapp.net" : null);
                    if (!targetJid) return sock.sendMessage(remoteJid, { text: "⚠️ Tag, reply, or provide the number of the user to unblock." }, { quoted: msg });
                    
                    try {
                        await sock.updateBlockStatus(targetJid, "unblock");
                        await sock.sendMessage(remoteJid, { text: `✅ Successfully unblocked @${extractDigits(targetJid)}`, mentions: [targetJid] }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, { text: `❌ Failed to unblock user: ${err.message}` }, { quoted: msg });
                    }
                    break;
                }

                case "antilink": {
                    if (!isGroup) {
                        await sock.sendMessage(remoteJid, { text: "⚠️ This command can only be used inside groups." }, { quoted: msg });
                        return;
                    }
                    const option = args[0]?.toLowerCase();
                    if (option === "on") {
                        antilinkGroups.add(remoteJid);
                        await sock.sendMessage(remoteJid, { text: "🛡️ *Anti-Link active.*" }, { quoted: msg });
                    } else if (option === "off") {
                        antilinkGroups.delete(remoteJid);
                        await sock.sendMessage(remoteJid, { text: "🛡️ *Anti-Link disabled.*" }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: "⚠️ Usage: `!antilink on` or `!antilink off`" }, { quoted: msg });
                    }
                    break;
                }

                case "warn": {
                    if (!isGroup) return sock.sendMessage(remoteJid, { text: "⚠️ This command can only be used inside groups." }, { quoted: msg });
                    const targetJid = mentioned[0] || quotedSender;
                    if (!targetJid) return sock.sendMessage(remoteJid, { text: "⚠️ Tag or reply to a user: `!warn @user <reason>`" }, { quoted: msg });
                    
                    const reason = args.filter(arg => !arg.includes("@")).join(" ");
                    if (!reason) return sock.sendMessage(remoteJid, { text: "⚠️ Provide a reason for the warning." }, { quoted: msg });

                    const targetDigits = extractDigits(targetJid);
                    const groupMeta = await sock.groupMetadata(remoteJid);

                    const sentDmReq = await sock.sendMessage(OWNER_JID, { 
                        text: `⏳ *PENDING PROMISE HENRY [KEAL_VIREK] APPROVAL (WARN)*\n\n🏠 Group: ${groupMeta.subject}\n👤 Action: WARN\n🎯 Target: @${targetDigits}\n📝 Reason: ${reason}\n\n_👉 Reply **approve** / **decline** or type **!grant** / **!decline** to respond._`, 
                        mentions: [targetJid] 
                    });

                    pendingApprovals.set(sentDmReq.key.id, { type: "warn", targetJid, remoteJid, reason });
                    lastPendingId = sentDmReq.key.id;

                    await sock.sendMessage(remoteJid, { text: "⏳ Waiting for Promise Henry [KEAL_VIREK] approval...", mentions: [targetJid] }, { quoted: msg });
                    break;
                }

                case "mute":
                case "timeout": {
                    if (!isGroup) return sock.sendMessage(remoteJid, { text: "⚠️ This command can only be used inside groups." }, { quoted: msg });
                    const targetJid = mentioned[0] || quotedSender;
                    if (!targetJid) return sock.sendMessage(remoteJid, { text: `⚠️ Usage: \`!${command} @user <time e.g. 5m> <reason>\`` }, { quoted: msg });

                    const durationStr = args.find(arg => /^\d+[smhd]\.?$/i.test(arg));
                    const durationMs = parseDuration(durationStr);
                    if (!durationMs) return sock.sendMessage(remoteJid, { text: `⚠️ Specify a valid duration (e.g. 30s, 10m, 2h).` }, { quoted: msg });

                    const reason = args.filter(arg => arg !== durationStr && !arg.includes("@")).join(" ");
                    if (!reason) return sock.sendMessage(remoteJid, { text: `⚠️ Provide a reason for the ${command}.` }, { quoted: msg });

                    const targetDigits = extractDigits(targetJid);
                    const groupMeta = await sock.groupMetadata(remoteJid);

                    const sentDmReq = await sock.sendMessage(OWNER_JID, { 
                        text: `⏳ *PENDING PROMISE HENRY [KEAL_VIREK] APPROVAL (${command.toUpperCase()})*\n\n🏠 Group: ${groupMeta.subject}\n👤 Action: ${command.toUpperCase()}\n🎯 Target: @${targetDigits}\n⏳ Duration: ${durationStr}\n📝 Reason: ${reason}\n\n_👉 Reply **approve** / **decline** or type **!grant** / **!decline** to respond._`, 
                        mentions: [targetJid] 
                    });

                    pendingApprovals.set(sentDmReq.key.id, { type: command, targetJid, remoteJid, durationStr, durationMs, reason });
                    lastPendingId = sentDmReq.key.id;

                    await sock.sendMessage(remoteJid, { text: "⏳ Waiting for Promise Henry [KEAL_VIREK] approval...", mentions: [targetJid] }, { quoted: msg });
                    break;
                }

                case "kick":
                case "ban": {
                    if (!isGroup) return sock.sendMessage(remoteJid, { text: "⚠️ This command can only be used inside groups." }, { quoted: msg });
                    const targetJid = mentioned[0] || quotedSender;
                    if (!targetJid) return sock.sendMessage(remoteJid, { text: `⚠️ Usage: \`!${command} @user <reason>\`` }, { quoted: msg });

                    const reason = args.filter(arg => !arg.includes("@")).join(" ");
                    if (!reason) return sock.sendMessage(remoteJid, { text: `⚠️ Provide a reason for the ${command}.` }, { quoted: msg });

                    const targetDigits = extractDigits(targetJid);
                    const groupMeta = await sock.groupMetadata(remoteJid);

                    const sentDmReq = await sock.sendMessage(OWNER_JID, { 
                        text: `⏳ *PENDING PROMISE HENRY [KEAL_VIREK] APPROVAL (${command.toUpperCase()})*\n\n🏠 Group: ${groupMeta.subject}\n👤 Action: ${command.toUpperCase()}\n🎯 Target: @${targetDigits}\n📝 Reason: ${reason}\n\n_👉 Reply **approve** / **decline** or type **!grant** / **!decline** to respond._`, 
                        mentions: [targetJid] 
                    });

                    pendingApprovals.set(sentDmReq.key.id, { type: command, targetJid, remoteJid, reason });
                    lastPendingId = sentDmReq.key.id;

                    await sock.sendMessage(remoteJid, { text: "⏳ Waiting for Promise Henry [KEAL_VIREK] approval...", mentions: [targetJid] }, { quoted: msg });
                    break;
                }

                case "unmute": {
                    if (!isGroup) return sock.sendMessage(remoteJid, { text: "⚠️ This command can only be used inside groups." }, { quoted: msg });
                    const targetJid = mentioned[0] || quotedSender;
                    if (!targetJid) return sock.sendMessage(remoteJid, { text: "⚠️ Tag or reply to the user you want to unmute." }, { quoted: msg });

                    const targetDigits = extractDigits(targetJid);
                    const groupMeta = await sock.groupMetadata(remoteJid);

                    const sentDmReq = await sock.sendMessage(OWNER_JID, { 
                        text: `⏳ *PENDING PROMISE HENRY [KEAL_VIREK] APPROVAL (UNMUTE)*\n\n🏠 Group: ${groupMeta.subject}\n👤 Action: UNMUTE\n🎯 Target: @${targetDigits}\n\n_👉 Reply **approve** / **decline** or type **!grant** / **!decline** to respond._`, 
                        mentions: [targetJid] 
                    });

                    pendingApprovals.set(sentDmReq.key.id, { type: "unmute", targetJid, remoteJid });
                    lastPendingId = sentDmReq.key.id;

                    await sock.sendMessage(remoteJid, { text: "⏳ Waiting for Promise Henry [KEAL_VIREK] approval...", mentions: [targetJid] }, { quoted: msg });
                    break;
                }

                case "clearchat": {
                    if (!isOwner && !allowedUsers.includes(senderDigits)) {
                        return sock.sendMessage(remoteJid, { text: "⚠️ Only Promise Henry [KEAL_VIREK] or authorized users can clear chats." }, { quoted: msg });
                    }
                    try {
                        await sock.chatModify({ 
                            delete: true, 
                            lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] 
                        }, remoteJid);
                        await sock.sendMessage(remoteJid, { text: "🧹 Chat cleared successfully!" });
                    } catch (err) {
                        console.error("Clear chat error:", err);
                        await sock.sendMessage(remoteJid, { text: "🧹 Clear chat executed." });
                    }
                    break;
                }

                // ==================== NUMBER LOOKUP COMMAND ====================
                case "check": {
                    const numberQuery = args[0];
                    if (!numberQuery) {
                        await sock.sendMessage(remoteJid, { text: "⚠️ Please provide a number to check. Example: `!check 2348123456789`" }, { quoted: msg });
                        return;
                    }

                    const cleanNumber = numberQuery.replace(/[^0-9]/g, '');
                    const targetJid = `${cleanNumber}@s.whatsapp.net`;

                    try {
                        const [result] = await sock.onWhatsApp(targetJid);

                        if (result && result.exists) {
                            await sock.sendMessage(remoteJid, { 
                                text: `✅ The number *+${cleanNumber}* is registered on WhatsApp!\n\nJID: \`${result.jid}\`` 
                            }, { quoted: msg });
                        } else {
                            await sock.sendMessage(remoteJid, { 
                                text: `❌ The number *+${cleanNumber}* is NOT registered on WhatsApp.` 
                            }, { quoted: msg });
                        }
                    } catch (error) {
                        console.error("Error checking number:", error);
                        await sock.sendMessage(remoteJid, { text: "⚠️ An error occurred while checking the number." }, { quoted: msg });
                    }
                    break;
                }

                // ==================== STEALTH GLOBAL LOCK NUMBER COMMAND (WITH APPROVAL) ====================
                case "locknumber": {
                    const numberQuery = args[0]; 
                    const durationStr = args[1]; 
                    const reason = args.slice(2).join(" "); 

                    if (!numberQuery || !durationStr || !reason) {
                        await sock.sendMessage(remoteJid, { 
                            text: "⚠️ Usage: `!locknumber <phone_number> <duration> <reason>`\nExample: `!locknumber 2348101047569 2h Insulting`" 
                        }, { quoted: msg });
                        return;
                    }

                    const cleanNumber = numberQuery.replace(/[^0-9]/g, '');
                    const targetJid = `${cleanNumber}@s.whatsapp.net`;
                    const durationMs = parseDuration(durationStr);

                    if (!durationMs) {
                        await sock.sendMessage(remoteJid, { text: "⚠️ Invalid duration format! Use 's', 'm', 'h', or 'd' (e.g., `2h`, `1d`)." }, { quoted: msg });
                        return;
                    }

                    const sentDmReq = await sock.sendMessage(OWNER_JID, { 
                        text: `⏳ *PENDING PROMISE HENRY [KEAL_VIREK] APPROVAL (GLOBAL LOCK)*\n\n👤 Action: LOCK NUMBER\n🎯 Target: +${cleanNumber}\n⏳ Duration: ${durationStr}\n📝 Reason: ${reason}\n\n_👉 Reply **approve** / **decline** or type **!grant** / **!decline** to respond._` 
                    });

                    pendingApprovals.set(sentDmReq.key.id, { type: "locknumber", targetJid, cleanNumber, remoteJid, durationStr, durationMs, reason });
                    lastPendingId = sentDmReq.key.id;

                    await sock.sendMessage(remoteJid, { text: "⏳ Waiting for Promise Henry [KEAL_VIREK] approval..." }, { quoted: msg });
                    break;
                }

                // ==================== REMOVE STEALTH LOCK (WITH APPROVAL) ====================
                case "unlocknumber": {
                    const numberQuery = args[0];
                    if (!numberQuery) {
                        await sock.sendMessage(remoteJid, { text: "⚠️ Please provide the number to unlock. Example: `!unlocknumber 2348101047569`" }, { quoted: msg });
                        return;
                    }

                    const cleanNumber = numberQuery.replace(/[^0-9]/g, '');
                    const targetJid = `${cleanNumber}@s.whatsapp.net`;

                    if (!mutedUsers.has(targetJid)) {
                        await sock.sendMessage(remoteJid, { text: `ℹ️ The number +${cleanNumber} is not currently in the active stealth lock list.` }, { quoted: msg });
                        return;
                    }

                    const sentDmReq = await sock.sendMessage(OWNER_JID, { 
                        text: `⏳ *PENDING PROMISE HENRY [KEAL_VIREK] APPROVAL (UNLOCK NUMBER)*\n\n👤 Action: UNLOCK NUMBER\n🎯 Target: +${cleanNumber}\n\n_👉 Reply **approve** / **decline** or type **!grant** / **!decline** to respond._` 
                    });

                    pendingApprovals.set(sentDmReq.key.id, { type: "unlocknumber", targetJid, cleanNumber, remoteJid });
                    lastPendingId = sentDmReq.key.id;

                    await sock.sendMessage(remoteJid, { text: "⏳ Waiting for Promise Henry [KEAL_VIREK] approval..." }, { quoted: msg });
                    break;
                }

                // ==================== CHECK & LIST COMMANDS ====================
                case "listmuted": {
                    if (!isGroup) return sock.sendMessage(remoteJid, { text: "⚠️ This command can only be used inside groups." }, { quoted: msg });
                    
                    const groupMuted = Array.from(mutedUsers).filter(key => key.startsWith(`${remoteJid}_`));
                    if (groupMuted.length === 0) {
                        await sock.sendMessage(remoteJid, { text: "🔊 There are no currently muted or timed-out users in this group." }, { quoted: msg });
                        break;
                    }

                    let listText = "📋 *MUTED / TIMED-OUT USERS IN THIS GROUP*:\n\n";
                    const mentionsList = [];
                    
                    groupMuted.forEach((key, index) => {
                        const targetJid = key.split("_")[1];
                        listText += `${index + 1}. @${extractDigits(targetJid)}\n`;
                        mentionsList.push(targetJid);
                    });

                    await sock.sendMessage(remoteJid, { text: listText, mentions: mentionsList }, { quoted: msg });
                    break;
                }

                case "listlocks": {
                    if (!isOwner) return sock.sendMessage(remoteJid, { text: "⚠️ Only Promise Henry [KEAL_VIREK] can view global stealth locks." }, { quoted: msg });
                    
                    const globalLocks = Array.from(mutedUsers).filter(key => !key.includes("_") && key.endsWith("@s.whatsapp.net"));
                    if (globalLocks.length === 0) {
                        await sock.sendMessage(remoteJid, { text: "🔓 There are currently no numbers under global stealth lock." }, { quoted: msg });
                        break;
                    }

                    let listText = "🔒 *GLOBALLY LOCKED NUMBERS (STEALTH MODE)*:\n\n";
                    globalLocks.forEach((jid, index) => {
                        listText += `${index + 1}. +${extractDigits(jid)}\n`;
                    });

                    await sock.sendMessage(remoteJid, { text: listText }, { quoted: msg });
                    break;
                }

                case "warnings": {
                    if (!isGroup) return sock.sendMessage(remoteJid, { text: "⚠️ This command can only be used inside groups." }, { quoted: msg });
                    const targetJid = mentioned[0] || quotedSender;
                    if (!targetJid) {
                        const count = userWarnings.get(senderJid) || 0;
                        await sock.sendMessage(remoteJid, { text: `⚠️ You have *${count}/3* warnings.`, mentions: [senderJid] }, { quoted: msg });
                        break;
                    }

                    const count = userWarnings.get(targetJid) || 0;
                    await sock.sendMessage(remoteJid, { text: `⚠️ User @${extractDigits(targetJid)} has *${count}/3* warnings.`, mentions: [targetJid] }, { quoted: msg });
                    break;
                }

                case "statusall": {
                    if (!isOwner) return sock.sendMessage(remoteJid, { text: "⚠️ Only the bot owner can view system status." }, { quoted: msg });
                    
                    const activeAntilinks = antilinkGroups.size;
                    const totalMutedOrLocked = mutedUsers.size;
                    const pendingCount = pendingApprovals.size;
                    const modeStatus = isPublicMode ? "Public 🌍" : "Private 🔒";

                    const statusSummary = `📊 *SYSTEM STATUS OVERVIEW* 📊\n\n` +
                        `- *Bot Mode:* ${modeStatus}\n` +
                        `- *Active Antilink Groups:* ${activeAntilinks}\n` +
                        `- *Total Muted/Locked Entities:* ${totalMutedOrLocked}\n` +
                        `- *Pending Approval Requests:* ${pendingCount}\n`;

                    await sock.sendMessage(remoteJid, { text: statusSummary }, { quoted: msg });
                    break;
                }

                // ==================== FUN COMMANDS ====================
                case "truth": {
                    const randomTruth = TRUTHS[Math.floor(Math.random() * TRUTHS.length)];
                    await sock.sendMessage(remoteJid, { text: `🧩 *TRUTH:* ${randomTruth}` }, { quoted: msg });
                    break;
                }

                case "dare": {
                    const randomDare = DARES[Math.floor(Math.random() * DARES.length)];
                    await sock.sendMessage(remoteJid, { text: `🔥 *DARE:* ${randomDare}` }, { quoted: msg });
                    break;
                }

                case "ship": {
                    const usersToShip = mentioned;
                    if (usersToShip.length < 2) {
                        return sock.sendMessage(remoteJid, { text: "⚠️ Please tag two users to ship them: `!ship @user1 @user2`" }, { quoted: msg });
                    }
                    const percentage = Math.floor(Math.random() * 101);
                    await sock.sendMessage(remoteJid, { 
                        text: `💘 *MATCHMAKER RESULT* 💘\n\n👥 @${extractDigits(usersToShip[0])} + @${extractDigits(usersToShip[1])}\n💖 Compatibility: ${percentage}%`, 
                        mentions: [usersToShip[0], usersToShip[1]] 
                    }, { quoted: msg });
                    break;
                }

                case "roll":
                case "dice": {
                    const diceRoll = Math.floor(Math.random() * 6) + 1;
                    const diceEmojis = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
                    await sock.sendMessage(remoteJid, { text: `🎲 You rolled a *${diceRoll}* ${diceEmojis[diceRoll - 1]}` }, { quoted: msg });
                    break;
                }

                case "coin":
                case "flip": {
                    const result = Math.random() < 0.5 ? "Heads 🪙" : "Tails 🪙";
                    await sock.sendMessage(remoteJid, { text: `🪙 The coin landed on: *${result}*` }, { quoted: msg });
                    break;
                }

                case "8ball": {
                    const question = args.join(" ");
                    if (!question) return sock.sendMessage(remoteJid, { text: "⚠️ Ask a question: `!8ball Will I win?`" }, { quoted: msg });
                    
                    let answer;
                    const qLower = question.toLowerCase();
                    if (qLower.includes("created") || qLower.includes("creator") || qLower.includes("made you") || qLower.includes("built you")) {
                        answer = "Promise Henry [KEAL_VIREK] 👑";
                    } else {
                        answer = EIGHT_BALL_RESPONSES[Math.floor(Math.random() * EIGHT_BALL_RESPONSES.length)];
                    }

                    await sock.sendMessage(remoteJid, { text: `🎱 *Question:* ${question}\n🔮 *Answer:* ${answer}` }, { quoted: msg });
                    break;
                }

                case "sticker":
                case "s": {
                    const quotedMsg = quotedContext?.quotedMessage;
                    const isDirectImage = msg.message?.imageMessage;
                    if (!isDirectImage && !quotedMsg?.imageMessage) return sock.sendMessage(remoteJid, { text: "⚠️ Reply or send an image with `!sticker`" }, { quoted: msg });
                    
                    const targetMsg = isDirectImage ? msg : { message: quotedMsg };
                    const buffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                    await sock.sendMessage(remoteJid, { sticker: buffer }, { quoted: msg });
                    break;
                }

                case "ai": {
                    const prompt = args.join(" ");
                    if (!prompt) return sock.sendMessage(remoteJid, { text: "⚠️ Usage: `!ai <query>`" }, { quoted: msg });
                    const aiRes = await axios.get(`https://apis.davidcyriltech.my.id/ai/chatbot?text=${encodeURIComponent(prompt)}`);
                    await sock.sendMessage(remoteJid, { text: `🤖 ${aiRes.data?.result || "No response."}` }, { quoted: msg });
                    break;
                }

                case "ping": {
                    await sock.sendMessage(remoteJid, { text: `🏓 Pong!` }, { quoted: msg });
                    break;
                }

                default: {
                    if (!validCommands.includes(command)) {
                        await sock.sendMessage(remoteJid, { text: `❌ *Command Not Found*\n\n⚠️ Unknown command: \`!${command}\`. Type \`!menu\` to see available options.` }, { quoted: msg });
                    }
                    break;
                }
            }
        } catch (err) {
            console.error("❌ Error handling message:", err);
        }
    });
}

startBot();
