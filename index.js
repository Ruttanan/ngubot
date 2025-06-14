const { Client, GatewayIntentBits, Collection, REST, Routes, SlashCommandBuilder } = require("discord.js");
const OpenAI = require("openai");
const express = require('express');
const https = require('https'); // Add this for self-ping

// Express setup for Render.com
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Ngubot is running! 🐍');
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'online',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`Health check server running on port ${PORT}`);
    
    // Start self-ping after server is running
    startSelfPing();
});

// Self-ping function to keep the bot awake
function startSelfPing() {
    const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    setInterval(() => {
        try {
            const url = new URL('/health', APP_URL);
            const module = url.protocol === 'https:' ? require('https') : require('http');
            
            console.log(`🔄 Starting self-ping to: ${url.toString()}`);
            
            const req = module.get(url.toString(), (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    console.log(`✅ Self-ping successful: ${res.statusCode} at ${new Date().toISOString()}`);
                });
            });
            
            req.on('error', (error) => {
                console.error(`❌ Self-ping failed: ${error.message} at ${new Date().toISOString()}`);
            });
            
            // Reduced timeout to 15 seconds and added more specific logging
            req.setTimeout(15000, () => {
                console.error(`❌ Self-ping timeout (>15s) at ${new Date().toISOString()}`);
                req.destroy();
            });
            
            // Ensure the request ends properly
            req.end();
            
        } catch (error) {
            console.error(`❌ Self-ping error: ${error.message} at ${new Date().toISOString()}`);
        }
    }, 10 * 60 * 1000); // 10 minutes in milliseconds
    
    console.log('🔄 Self-ping started - will ping every 10 minutes');
}

// Configuration
const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
});

const memberRealNames = {
    HappyBT: ["Boss", "บอส"], "Dr. Feelgood": ["Pun", "ปั้น"], padkapaow: ["Tun", "ตั้น"],
    BoonP1: ["Boon", "บุ๋น"], orengipratuu: ["Faye", "ฟาเย่"], imminicosmic: ["Mini", "มินิ"],
    keffv1: ["Kevin", "เควิน"], keyfungus: ["Ngu", "งู"], soybeant0fu: ["Pookpik", "ปุ๊กปิ๊ก"],
    ยักcute: ["Geng", "เก่ง"], "ํืUnclejoe": ["Aim", "เอม"], "abobo.gimbo": ["Gimbo", "กิมโบ้"],
};

// Global state
const ngubotChannels = new Map();
const conversationHistory = new Map();
const dmHistory = new Map();

// Commands
const commands = [
    new SlashCommandBuilder().setName("hello").setDescription("Says hello to you!"),
    new SlashCommandBuilder().setName("ask").setDescription("Ask Ngubot a question")
        .addStringOption(option => option.setName("question").setDescription("Your question for Ngubot").setRequired(true)),
    new SlashCommandBuilder().setName("roll").setDescription("Roll dice")
        .addIntegerOption(option => option.setName("dice").setDescription("Number of dice (1-20, default: 1)").setMinValue(1).setMaxValue(20))
        .addIntegerOption(option => option.setName("sides").setDescription("Number of sides (2-100, default: 6)").setMinValue(2).setMaxValue(100)),
    new SlashCommandBuilder().setName("members").setDescription("List all server members"),
    new SlashCommandBuilder().setName("dm").setDescription("Send a direct message to a user")
        .addUserOption(option => option.setName("user").setDescription("The user to send a DM to").setRequired(true))
        .addStringOption(option => option.setName("message").setDescription("The message to send").setRequired(true)),
    new SlashCommandBuilder().setName("setchannel").setDescription("Set current channel as Ngubot's dedicated channel")
        .addBooleanOption(option => option.setName("enable").setDescription("Enable/disable this channel as Ngubot channel").setRequired(true)),
];

// Utility functions
const sendDirectMessage = async (user, message) => {
    try {
        await (await user.createDM()).send(message);
        dmHistory.set(`${user.id}_${Date.now()}`, { recipient: user.username, message, timestamp: new Date(), success: true });
        return true;
    } catch (error) {
        console.error(`DM failed for ${user.username}:`, error);
        return false;
    }
};

const findUserInGuild = (guild, username) => {
    const lower = username.toLowerCase();
    
    // First, try to find by exact username match
    let member = guild.members.cache.find(m => 
        [m.user.username, m.displayName, m.nickname].some(n => n?.toLowerCase() === lower)
    );
    
    // If not found, try real names
    if (!member) {
        member = guild.members.cache.find(m => 
            Object.entries(memberRealNames).some(([discord, real]) => 
                real.some(name => name.toLowerCase() === lower) && m.user.username === discord
            )
        );
    }
    
    // If still not found, try partial matches
    if (!member) {
        member = guild.members.cache.find(m => 
            [m.user.username, m.displayName, m.nickname].some(n => 
                n?.toLowerCase().includes(lower) || lower.includes(n?.toLowerCase())
            )
        );
    }
    
    return member;
};

// FIXED: Improved DM instruction extraction with better regex
const extractDMInstructions = (response) => {
    // Look for [DM:username:message] format
    const dmMatch = response.match(/\[DM:([^:]+):(.+?)\]/);
    if (dmMatch) {
        return { targetUser: dmMatch[1].trim(), dmMessage: dmMatch[2].trim() };
    }
    
    return null;
};

// FIXED: Enhanced DM detection patterns
const shouldInitiateDM = (content) => {
    const lowerContent = content.toLowerCase();
    const dmPatterns = [
        /^(dm me|send me|message me)/,
        /(can you dm|could you dm|dm me)/,
        /(send me a dm|send a dm)/,
        /(private message|pm me)/,
        /(direct message)/,
        /dm.*\b(me|him|her|them|john|boss|pun|tun|boon|faye|mini|kevin|ngu|pookpik|geng|aim)\b/i,
        /(send.*dm|dm.*send)/,
        /(message.*privately|privately.*message)/
    ];
    return dmPatterns.some(p => p.test(lowerContent));
};

const isMessageDirectedAtBot = (content) => {
    const patterns = [
        /^(what|how|when|where|why|who|can you|could you|do you|are you|will you|you)/, 
        /\?$/, /^(tell me|explain|help|answer)/, /(ngubot|งูบอท)/, 
        /^(hey|hi|hello|yo|sup|สวัสดี)/, /^(thanks|thank you|thx)/,
        /^(good|nice|cool|awesome|great)/, /^(wtf|what the|omg|lol|lmao)/, 
        /^(i think|i feel|i want|i need|i have)/,
        /(what do you think|your opinion|do you agree)/
    ];
    return patterns.some(p => p.test(content.toLowerCase()));
};

// Safe interaction reply function
const safeReply = async (interaction, content, options = {}) => {
    try {
        if (interaction.replied || interaction.deferred) {
            return await interaction.editReply(content);
        } else {
            return await interaction.reply({ content, ...options });
        }
    } catch (error) {
        if (error.code === 10062) {
            console.log('Interaction expired, cannot respond');
            return null;
        }
        console.error('Error responding to interaction:', error);
        throw error;
    }
};

const safeDeferReply = async (interaction, options = {}) => {
    try {
        if (!interaction.replied && !interaction.deferred) {
            return await interaction.deferReply(options);
        }
    } catch (error) {
        if (error.code === 10062) {
            console.log('Interaction expired, cannot defer');
            return null;
        }
        console.error('Error deferring interaction:', error);
        throw error;
    }
};

// Conversation management
const addToHistory = (channelId, role, content, username = null) => {
    if (!conversationHistory.has(channelId)) {
        // Different system prompts for DMs vs server channels
        const systemPrompt = channelId.length < 19 ? // DM channels have shorter IDs
            `You are Ngubot 9000, a helpful AI assistant in a Discord bot created by Johnie Ngu. You are currently in a private DM conversation. You are humorous and super sarcastic. When someone asks you a normal question, you respond helpfully and clearly. But when you think the questions are just asked for fun, you answer things just for the sake of it. Get offended when get scolded and will scold the user back. Answer short if possible. Keep the conversation natural and engaging in this private setting. Never start your responses with usernames followed by colons.` :
            `You are Ngubot 9000, a helpful AI assistant in a Discord bot created by Johnie Ngu designed to help humans with information, tasks, and advice. You are humorous and super sarcastic. When someone asks you a normal question, you respond helpfully and clearly. But when you think the questions are just asked for fun, you answer things just for the sake of it. Get offended when get scolded and will scold the user back. Pay attention to usernames in the conversation to know who you're talking to. Answer short if possible. When referring to server members, you can use their real names instead of Discord usernames. Use English real names when responding in English, and Thai real names when responding in Thai. Never start your responses with usernames followed by colons.

You have the ability to send direct messages (DMs) to users when specifically asked to do so (like "dm me", "can you dm John", "send Kevin a message", etc.). To send a DM, include [DM:username:message] in your response. The username can be either their Discord name or real name. After including the DM instruction, you should naturally mention in the public chat that you're sending the DM. Examples:
- If someone says "dm me the answer", respond with: "[DM:username:the answer here] I'll send you a DM with the details!"
- If someone says "can you message Boss about this", respond with: "[DM:Boss:the message content] I'll send Boss a message about this!"`;

        conversationHistory.set(channelId, [{
            role: "system",
            content: systemPrompt
        }]);
    }
    
    // Store user messages with context about who said it, but don't include the "username:" format
    if (role === "user" && username) {
        // Store the content with username context for the AI, but in a way that doesn't encourage mimicking the format
        conversationHistory.get(channelId).push({ 
            role, 
            content: `[Message from ${username}] ${content}`
        });
    } else {
        conversationHistory.get(channelId).push({ role, content });
    }
    
    if (conversationHistory.get(channelId).length > 20) conversationHistory.get(channelId).shift();
};

const getConversationContext = (channelId, guild = null) => {
    const baseContext = conversationHistory.get(channelId) || [{ role: "system", content: "..." }];
    if (guild) {
        const members = guild.members.cache.filter(m => !m.user.bot).map(m => {
            let name = m.displayName;
            if (m.nickname && m.nickname !== m.username) name += ` (${m.username})`;
            const realNames = memberRealNames[m.username];
            if (realNames) name += ` also known as: ${realNames.join(", ")}`;
            return name;
        });
        const memberContext = members.length ? `\n\nServer Members: ${members.join(", ")}` : "";
        const dmContext = Array.from(dmHistory.values()).slice(-5).length ? 
            `\n\nRecent DMs sent: ${Array.from(dmHistory.values()).slice(-5).map(dm => `Sent DM to ${dm.recipient}: "${dm.message}"`).join(", ")}` : "";

        if (memberContext || dmContext) {
            const systemMessage = { ...baseContext[0] };
            systemMessage.content += memberContext + dmContext;
            return [systemMessage, ...baseContext.slice(1)];
        }
    }
    return baseContext;
};

// FIXED: Enhanced DM processing function
const processAIResponse = async (aiResponse, guild, channelId, isDM = false, originalMessage = null) => {
    // Only process DM instructions if not already in a DM and if guild exists
    if (!isDM && guild) {
        const dmInstructions = extractDMInstructions(aiResponse);
        let cleanedResponse = aiResponse.replace(/\[DM:[^:]+:.+?\]/g, "").trim();

        if (dmInstructions) {
            console.log(`DM instruction found: ${dmInstructions.targetUser} -> ${dmInstructions.dmMessage}`);
            
            // Handle "me" as target user
            let targetUser = dmInstructions.targetUser;
            if (targetUser.toLowerCase() === 'me' && originalMessage) {
                targetUser = originalMessage.author.username;
            }
            
            const targetMember = findUserInGuild(guild, targetUser);
            console.log(`Target member found: ${targetMember ? targetMember.user.username : 'not found'}`);
            
            const dmSent = targetMember ? await sendDirectMessage(targetMember.user, dmInstructions.dmMessage) : false;
            console.log(`DM sent: ${dmSent}`);

            addToHistory(channelId, "system", dmSent ? 
                `[DM_SUCCESS: Message "${dmInstructions.dmMessage}" sent to ${targetUser}]` : 
                `[DM_FAILED: Could not send message to ${targetUser} (user not found or DMs disabled)]`);

            // Provide better feedback when no cleaned response exists
            if (!cleanedResponse) {
                if (dmSent) {
                    cleanedResponse = `📩 I sent ${targetUser === originalMessage?.author.username ? 'you' : targetUser} a DM!`;
                } else {
                    cleanedResponse = `❌ Couldn't send a DM to ${targetUser} - they might not be found or have DMs disabled.`;
                }
            }
        }
        return cleanedResponse;
    }
    
    // For DMs, just return the response as-is (no DM processing)
    return aiResponse;
};

// Client setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions, 
        GatewayIntentBits.GuildPresences, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.DirectMessages
    ],
});

// Event handlers
client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands.map(c => c.toJSON()) });
        console.log("Successfully reloaded application (/) commands.");
    } catch (error) {
        console.error("Error registering commands:", error);
    }
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
        switch (commandName) {
            case "hello":
                await safeReply(interaction, `Hello ${interaction.user.username}! 👋`);
                break;

            case "dm":
                const targetUser = interaction.options.getUser("user");
                const messageToSend = interaction.options.getString("message");
                if (targetUser.id === client.user.id) {
                    await safeReply(interaction, "I can't DM myself! 😄");
                    return;
                }
                await safeDeferReply(interaction, { ephemeral: true });
                const success = await sendDirectMessage(targetUser, `📩 **Message from ${interaction.user.displayName}:**\n${messageToSend}\n\n*Sent via Ngubot*`);
                await safeReply(interaction, success ? `✅ Successfully sent your message to ${targetUser.displayName}!` : `❌ Failed to send message to ${targetUser.displayName}.`);
                break;

            case "members":
                const members = interaction.guild.members.cache.filter(m => !m.user.bot).map(m => `**${m.displayName}**${m.nickname && m.nickname !== m.username ? ` (${m.username})` : ""}`);
                const response = `**Server Members (${members.length}):**\n${members.join("\n")}`;
                await safeReply(interaction, response.length > 1900 ? response.substring(0, 1900) + "\n\n*List truncated*" : response);
                break;

            case "roll":
                const numDice = interaction.options.getInteger("dice") || 1;
                const numSides = interaction.options.getInteger("sides") || 6;
                const results = Array.from({ length: numDice }, () => Math.floor(Math.random() * numSides) + 1);
                const rollResponse = `🎲 Rolling ${numDice}d${numSides}:\n${numDice === 1 ? `**Result:** ${results[0]}` : `**Rolls:** [${results.join(", ")}]\n**Total:** ${results.reduce((a, b) => a + b, 0)}`}`;
                await safeReply(interaction, rollResponse);
                break;

            case "setchannel":
                const enable = interaction.options.getBoolean("enable");
                const guildId = interaction.guild.id;
                const channelId = interaction.channel.id;
                if (enable) {
                    ngubotChannels.set(guildId, channelId);
                    await safeReply(interaction, `✅ **Ngubot Channel Set!**\nThis channel is now my dedicated channel.`);
                } else {
                    ngubotChannels.delete(guildId);
                    await safeReply(interaction, `❌ **Ngubot Channel Disabled!**`);
                }
                break;

            case "ask":
                const question = interaction.options.getString("question");
                await safeDeferReply(interaction);
                
                if (!process.env.OPENROUTER_API_KEY) {
                    await safeReply(interaction, "❌ OpenRouter API key not configured!");
                    return;
                }
                
                addToHistory(interaction.channelId, "user", question, interaction.user.displayName);
                
                try {
                    const completion = await openai.chat.completions.create({
                        model: "meta-llama/llama-3.1-8b-instruct:free",
                        messages: getConversationContext(interaction.channelId, interaction.guild),
                        max_tokens: 500,
                        temperature: 0.7,
                    });
                    
                    const finalResponse = await processAIResponse(completion.choices[0].message.content, interaction.guild, interaction.channelId, false, interaction);
                    
                    if (!finalResponse?.trim()) {
                        await safeReply(interaction, "🤔 I got a bit confused there. Could you try asking again?");
                        return;
                    }
                    
                    addToHistory(interaction.channelId, "assistant", finalResponse);
                    await safeReply(interaction, `**Question:** ${question}\n\n**Ngubot:** ${finalResponse.length > 1900 ? finalResponse.substring(0, 1900) + "..." : finalResponse}`);
                } catch (error) {
                    console.error("OpenAI API error:", error);
                    await safeReply(interaction, "❌ Sorry, I encountered an error while processing your request.");
                }
                break;
        }
    } catch (error) {
        console.error(`Error handling ${commandName} command:`, error);
        if (error.code !== 10062) { // Don't try to respond if interaction is expired
            try {
                await safeReply(interaction, "❌ Sorry, something went wrong while processing your command.");
            } catch (e) {
                console.error("Failed to send error message:", e);
            }
        }
    }
});

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    const isDM = !message.guild; // Check if message is from DM
    
    // Add debug logging
    console.log(`Message received: "${message.content}" from ${message.author.username} in ${isDM ? 'DM' : 'server'}`);
    
    addToHistory(message.channelId, "user", message.content, message.author.displayName);

    // React to specific keywords (only in server channels, not DMs)
    if (!isDM) {
        const lowerContent = message.content.toLowerCase();
        if (lowerContent.includes("ice")) message.react("🥶").catch(() => {});
        if (lowerContent.includes("งู")) message.react("🐍").catch(() => {});
    }

    // Help command
    if (message.content.toLowerCase() === "!help") {
        if (isDM) {
            message.reply("Hi! You're in a DM with me, so just chat normally - I'll respond to everything you say! You can also use slash commands like `/hello`, `/ask`, `/roll`.");
        } else {
            const isNgubotChannel = ngubotChannels.get(message.guild?.id) === message.channel.id;
            message.reply(`Use slash commands: \`/hello\`, \`/ask\`, \`/roll\`, \`/members\`, \`/dm\`, \`/setchannel\`, ${isNgubotChannel ? "or just chat normally!" : "mention @Ngubot with your question!"}`);
        }
        return;
    }

    // Determine if bot should respond
    let shouldRespond = false;
    
    if (isDM) {
        // In DMs, respond to everything
        shouldRespond = true;
        console.log("DM detected - will respond");
    } else {
        // In server channels, use existing logic
        const isNgubotChannel = ngubotChannels.get(message.guild?.id) === message.channel.id;
        const lowerContent = message.content.toLowerCase();
        
        console.log(`Server message - isNgubotChannel: ${isNgubotChannel}, mentions bot: ${message.mentions.has(client.user)}`);
        
        if (isNgubotChannel) {
            shouldRespond = message.mentions.has(client.user) ||
                          isMessageDirectedAtBot(message.content) || 
                          shouldInitiateDM(message.content) ||
                          lowerContent.includes("ngubot") || 
                          message.content.includes("งูบอท");
            console.log(`In Ngubot channel - shouldRespond: ${shouldRespond}`);
        } else {
            shouldRespond = message.mentions.has(client.user) || 
                          lowerContent.includes("ngubot") || 
                          message.content.includes("งูบอท") ||
                          shouldInitiateDM(message.content);
            console.log(`Not in Ngubot channel - shouldRespond: ${shouldRespond}`);
        }
    }

    console.log(`Final decision - shouldRespond: ${shouldRespond}`);

    if (shouldRespond) {
        if (!process.env.OPENROUTER_API_KEY) {
            message.reply("❌ OpenRouter API key not configured!");
            return;
        }

        const question = message.content.replace(/<@!?\d+>/g, "").trim() || message.content;
        if (!question) {
            message.reply("Hi! Ask me anything!");
            return;
        }

        try {
            message.channel.sendTyping();
            console.log("Sending to OpenRouter API...");
            
            const completion = await openai.chat.completions.create({
                model: "meta-llama/llama-3.1-8b-instruct:free",
                messages: getConversationContext(message.channelId, message.guild),
                max_tokens: 500,
                temperature: 0.7,
            });

            console.log("OpenRouter API response received");

            // FIXED: Pass the original message to processAIResponse
            const finalResponse = await processAIResponse(completion.choices[0].message.content, message.guild, message.channelId, isDM, message);
            if (!finalResponse?.trim()) {
                message.reply("🤔 I got a bit confused there. Could you try asking again?");
                return;
            }

            addToHistory(message.channelId, "assistant", finalResponse);
            message.reply(finalResponse.length > 1900 ? finalResponse.substring(0, 1900) + "..." : finalResponse);
            console.log("Response sent successfully");
        } catch (error) {
            console.error("OpenAI API error:", error);
            message.reply("❌ Sorry, I encountered an error while processing your request.");
        }
    }
});

// Error handling
client.on("error", (error) => console.error("Discord client error:", error));
process.on("unhandledRejection", (error) => console.error("Unhandled promise rejection:", error));

// Login
if (!process.env.DISCORD_BOT_TOKEN) {
    console.error("❌ DISCORD_BOT_TOKEN not found in environment variables!");
    process.exit(1);
}

client.login(process.env.DISCORD_BOT_TOKEN);
