const { Client, GatewayIntentBits, Collection, REST, Routes, SlashCommandBuilder, ChannelType } = require("discord.js");
const OpenAI = require("openai");
const express = require('express');

// Configuration
const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
});

const memberRealNames = {
    HappyBT: ["Boss", "บอส"], 
    "Dr. Feelgood": ["Pun", "ปั้น"], 
    padkapaow: ["Tun", "ตั้น"],
    BoonP1: ["Boon", "บุ๋น"], 
    orengipratuu: ["Faye", "ฟาเย่"], 
    imminicosmic: ["Mini", "มินิ"],
    keffv1: ["Kevin", "เควิน"], 
    keyfungus: ["Ngu", "งู"], 
    soybeant0fu: ["Pookpik", "ปุ๊กปิ๊ก"],
    "ยักcute": ["Geng", "เก่ง"], 
    "ํUnclejoe": ["Aim", "เอม"],
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
        const dmChannel = await user.createDM();
        await dmChannel.send(message);
        dmHistory.set(`${user.id}_${Date.now()}`, { 
            recipient: user.username, 
            message, 
            timestamp: new Date(), 
            success: true 
        });
        return true;
    } catch (error) {
        console.error(`DM failed for ${user.username}:`, error);
        dmHistory.set(`${user.id}_${Date.now()}`, { 
            recipient: user.username, 
            message, 
            timestamp: new Date(), 
            success: false,
            error: error.message 
        });
        return false;
    }
};

const findUserInGuild = (guild, username) => {
    if (!guild) return null;
    
    const lower = username.toLowerCase();
    
    // First try exact matches
    let member = guild.members.cache.find(m => 
        [m.user.username, m.displayName, m.nickname].some(n => n?.toLowerCase() === lower)
    );
    
    // Then try real names
    if (!member) {
        member = guild.members.cache.find(m => 
            Object.entries(memberRealNames).some(([discord, real]) => 
                real.some(name => name.toLowerCase() === lower) && m.user.username === discord
            )
        );
    }
    
    return member;
};

const extractDMInstructions = (response) => {
    const match = response.match(/\[DM:([^:]+):(.+?)\]/);
    return match ? { targetUser: match[1].trim(), dmMessage: match[2].trim() } : null;
};

const isMessageDirectedAtBot = (content) => {
    const patterns = [
        /^(what|how|when|where|why|who|can you|could you|do you|are you|will you|you)/, 
        /\?$/, 
        /^(tell me|explain|help|answer)/, 
        /(ngubot|งูบอท)/, 
        /^(hey|hi|hello|yo|sup|สวัสดี)/, 
        /^(thanks|thank you|thx)/,
        /^(good|nice|cool|awesome|great)/, 
        /^(wtf|what the|omg|lol|lmao)/, 
        /^(i think|i feel|i want|i need|i have)/,
        /(what do you think|your opinion|do you agree)/
    ];
    return patterns.some(p => p.test(content.toLowerCase()));
};

const isDMRequest = (content) => {
    const dmPatterns = [
        /(dm me|send me a dm|direct message me|private message me)/i,
        /(can you dm|could you dm|please dm)/i,
        /(dm .+ |send .+ a dm|message .+ privately)/i
    ];
    return dmPatterns.some(p => p.test(content));
};

// Conversation management
const addToHistory = (channelId, role, content) => {
    if (!conversationHistory.has(channelId)) {
        conversationHistory.set(channelId, [{
            role: "system",
            content: `You are Ngubot 9000, a helpful AI assistant in a Discord bot created by Johnie Ngu designed to help humans with information, tasks, and advice. You are humorous and super sarcastic. When someone asks you a normal question, you respond helpfully and clearly. But when you think the questions are just asked for fun, you answer things just for the sake of it. Get offended when get scolded and will scold the user back. Pay attention to usernames in the conversation to know who you're talking to. Answer short if possible. When referring to server members, you can use their real names instead of Discord usernames. Use English real names when responding in English, and Thai real names when responding in Thai. 

IMPORTANT: You should ONLY send direct messages (DMs) when explicitly asked to do so with phrases like "dm me", "send me a dm", "can you dm me", or "dm [username]". To send a DM, include [DM:username:message] in your response. After sending a DM, you should naturally mention in the public chat that you sent the DM and whether it was successful. Do NOT automatically send DMs for regular conversations.`
        }]);
    }
    
    const history = conversationHistory.get(channelId);
    history.push({ role, content });
    
    // Keep only last 20 messages (but always keep the system message)
    if (history.length > 21) {
        conversationHistory.set(channelId, [history[0], ...history.slice(-20)]);
    }
};

const getConversationContext = (channelId, guild = null, isDM = false) => {
    const baseContext = conversationHistory.get(channelId) || [{ 
        role: "system", 
        content: isDM ? 
            "You are Ngubot 9000, a helpful AI assistant in a Discord bot created by Johnie Ngu. You are humorous and super sarcastic. When someone asks you a normal question, you respond helpfully and clearly. But when you think the questions are just asked for fun, you answer things just for the sake of it. Get offended when get scolded and will scold the user back. Answer short if possible. This is a private DM conversation, so respond naturally without needing mentions or special triggers." :
            "You are Ngubot 9000, a helpful AI assistant in a Discord bot created by Johnie Ngu designed to help humans with information, tasks, and advice. You are humorous and super sarcastic. When someone asks you a normal question, you respond helpfully and clearly. But when you think the questions are just asked for fun, you answer things just for the sake of it. Get offended when get scolded and will scold the user back. Pay attention to usernames in the conversation to know who you're talking to. Answer short if possible. When referring to server members, you can use their real names instead of Discord usernames. Use English real names when responding in English, and Thai real names when responding in Thai."
    }];
    
    if (guild && !isDM) {
        try {
            const members = guild.members.cache
                .filter(m => !m.user.bot)
                .map(m => {
                    let name = m.displayName;
                    if (m.nickname && m.nickname !== m.user.username) {
                        name += ` (${m.user.username})`;
                    }
                    const realNames = memberRealNames[m.user.username];
                    if (realNames) {
                        name += ` also known as: ${realNames.join(", ")}`;
                    }
                    return name;
                });
            
            const memberContext = members.length ? `\n\nServer Members: ${members.join(", ")}` : "";
            const recentDMs = Array.from(dmHistory.values()).slice(-5);
            const dmContext = recentDMs.length ? 
                `\n\nRecent DMs sent: ${recentDMs.map(dm => `${dm.success ? 'Successfully sent' : 'Failed to send'} DM to ${dm.recipient}: "${dm.message}"`).join(", ")}` : "";

            if (memberContext || dmContext) {
                const systemMessage = { ...baseContext[0] };
                systemMessage.content += memberContext + dmContext;
                return [systemMessage, ...baseContext.slice(1)];
            }
        } catch (error) {
            console.error("Error building conversation context:", error);
        }
    }
    
    return baseContext;
};

const processAIResponse = async (aiResponse, guild, channelId, isDM = false) => {
    if (!aiResponse || typeof aiResponse !== 'string') {
        return "🤔 I got a bit confused there. Could you try asking again?";
    }

    // Only process DM instructions if not already in a DM
    if (!isDM && guild) {
        const dmInstructions = extractDMInstructions(aiResponse);
        let cleanedResponse = aiResponse.replace(/\[DM:[^:]+:.+?\]/g, "").trim();

        if (dmInstructions) {
            const targetMember = findUserInGuild(guild, dmInstructions.targetUser);
            const dmSent = targetMember ? await sendDirectMessage(targetMember.user, dmInstructions.dmMessage) : false;

            addToHistory(channelId, "system", dmSent ? 
                `[DM_SUCCESS: Message "${dmInstructions.dmMessage}" sent to ${dmInstructions.targetUser}]` : 
                `[DM_FAILED: Could not send message to ${dmInstructions.targetUser} (user not found or DMs disabled)]`);

            if (!cleanedResponse) {
                cleanedResponse = dmSent ? `📩 I sent you a DM!` : `❌ Couldn't send you a DM - you might have them disabled.`;
            }
        }
        return cleanedResponse;
    }
    
    // For DM conversations, just return the response as-is (no DM processing)
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

// Health check server setup
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Ngubot is running! 🐍');
});

app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        botStatus: client.readyAt ? 'ready' : 'not ready',
        guilds: client.guilds.cache.size,
        users: client.users.cache.size,
        activeChannels: conversationHistory.size,
        totalDMsSent: dmHistory.size
    });
});

app.listen(PORT, () => {
    console.log(`Health check server running on port ${PORT}`);
});

// Event handlers
client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log(`Bot is in ${client.guilds.cache.size} guilds`);
    
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try {
        console.log("Started refreshing application (/) commands.");
        await rest.put(Routes.applicationCommands(client.user.id), { 
            body: commands.map(c => c.toJSON()) 
        });
        console.log("Successfully reloaded application (/) commands.");
    } catch (error) {
        console.error("Error registering commands:", error);
    }
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    console.log(`Command used: ${commandName} by ${interaction.user.username}`);

    try {
        switch (commandName) {
            case "hello":
                await interaction.reply(`Hello ${interaction.user.username}! 👋`);
                break;

            case "dm":
                const targetUser = interaction.options.getUser("user");
                const messageToSend = interaction.options.getString("message");
                
                if (targetUser.id === interaction.user.id) {
                    await interaction.reply({ content: "You can't DM yourself through me! 😄", ephemeral: true });
                    return;
                }
                
                if (targetUser.id === client.user.id) {
                    await interaction.reply({ content: "I can't DM myself! 😄", ephemeral: true });
                    return;
                }
                
                await interaction.deferReply({ ephemeral: true });
                const success = await sendDirectMessage(targetUser, 
                    `📩 **Message from ${interaction.user.displayName}:**\n${messageToSend}\n\n*Sent via Ngubot*`
                );
                await interaction.editReply(
                    success ? 
                    `✅ Successfully sent your message to ${targetUser.displayName}!` : 
                    `❌ Failed to send message to ${targetUser.displayName}. They may have DMs disabled.`
                );
                break;

            case "members":
                if (!interaction.guild) {
                    await interaction.reply({ content: "This command only works in servers!", ephemeral: true });
                    return;
                }
                
                const members = interaction.guild.members.cache
                    .filter(m => !m.user.bot)
                    .map(m => `**${m.displayName}**${m.nickname && m.nickname !== m.user.username ? ` (${m.user.username})` : ""}`);
                
                const response = `**Server Members (${members.length}):**\n${members.join("\n")}`;
                await interaction.reply(response.length > 1900 ? response.substring(0, 1900) + "\n\n*List truncated*" : response);
                break;

            case "roll":
                const numDice = interaction.options.getInteger("dice") || 1;
                const numSides = interaction.options.getInteger("sides") || 6;
                const results = Array.from({ length: numDice }, () => Math.floor(Math.random() * numSides) + 1);
                const rollResponse = `🎲 Rolling ${numDice}d${numSides}:\n${numDice === 1 ? 
                    `**Result:** ${results[0]}` : 
                    `**Rolls:** [${results.join(", ")}]\n**Total:** ${results.reduce((a, b) => a + b, 0)}`}`;
                await interaction.reply(rollResponse);
                break;

            case "setchannel":
                if (!interaction.guild) {
                    await interaction.reply({ content: "This command only works in servers!", ephemeral: true });
                    return;
                }
                
                const enable = interaction.options.getBoolean("enable");
                const guildId = interaction.guild.id;
                const channelId = interaction.channel.id;
                
                if (enable) {
                    ngubotChannels.set(guildId, channelId);
                    await interaction.reply(`✅ **Ngubot Channel Set!**\nThis channel is now my dedicated channel. I'll respond to messages that seem directed at me here.`);
                } else {
                    ngubotChannels.delete(guildId);
                    await interaction.reply(`❌ **Ngubot Channel Disabled!**\nI'll only respond when mentioned now.`);
                }
                break;

            case "ask":
                const question = interaction.options.getString("question");
                await interaction.deferReply();
                
                if (!process.env.OPENROUTER_API_KEY) {
                    await interaction.editReply("❌ OpenRouter API key not configured!");
                    return;
                }
                
                addToHistory(interaction.channelId, "user", `${interaction.user.displayName}: ${question}`);
                
                try {
                    const completion = await openai.chat.completions.create({
                        model: "meta-llama/llama-3.1-8b-instruct:free",
                        messages: getConversationContext(interaction.channelId, interaction.guild, false),
                        max_tokens: 500,
                        temperature: 0.7,
                    });
                    
                    const aiResponse = completion.choices[0]?.message?.content;
                    if (!aiResponse) {
                        await interaction.editReply("🤔 I didn't get a response from the AI. Please try again.");
                        return;
                    }
                    
                    const finalResponse = await processAIResponse(aiResponse, interaction.guild, interaction.channelId, false);
                    
                    if (!finalResponse?.trim()) {
                        await interaction.editReply("🤔 I got a bit confused there. Could you try asking again?");
                        return;
                    }
                    
                    addToHistory(interaction.channelId, "assistant", finalResponse);
                    const replyContent = `**Question:** ${question}\n\n**Ngubot:** ${finalResponse.length > 1800 ? finalResponse.substring(0, 1800) + "..." : finalResponse}`;
                    await interaction.editReply(replyContent);
                    
                } catch (error) {
                    console.error("OpenAI API error:", error);
                    await interaction.editReply("❌ Sorry, I encountered an error while processing your request. Please try again later.");
                }
                break;
        }
    } catch (error) {
        console.error(`Error handling command ${commandName}:`, error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: "❌ An error occurred while processing your command.", ephemeral: true });
        } else if (interaction.deferred) {
            await interaction.editReply("❌ An error occurred while processing your command.");
        }
    }
});

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // Check if this is a DM
    const isDM = message.channel.type === ChannelType.DM;

    // Add to conversation history
    addToHistory(message.channelId, "user", `${message.author.displayName}: ${message.content}`);

    // React to specific keywords (only in guild channels, not DMs)
    if (!isDM) {
        try {
            const lowerContent = message.content.toLowerCase();
            if (lowerContent.includes("ice")) {
                await message.react("🥶");
            }
            if (lowerContent.includes("งู")) {
                await message.react("🐍");
            }
        } catch (error) {
            console.error("Error adding reactions:", error);
        }
    }

    // Help command
    if (message.content.toLowerCase() === "!help") {
        try {
            if (isDM) {
                await message.reply("In DMs, just chat with me normally! I'll respond to all your messages. You can also use slash commands in servers.");
            } else {
                const isNgubotChannel = ngubotChannels.get(message.guild?.id) === message.channel.id;
                await message.reply(`Use slash commands: \`/hello\`, \`/ask\`, \`/roll\`, \`/members\`, \`/dm\`, \`/setchannel\`, ${isNgubotChannel ? "or just chat normally!" : "mention @Ngubot with your question!"}`);
            }
        } catch (error) {
            console.error("Error sending help message:", error);
        }
        return;
    }

    // Determine if bot should respond
    let shouldRespond = false;

    if (isDM) {
        // In DMs, respond to every message
        shouldRespond = true;
    } else if (message.guild) {
        // In guild channels, use existing logic
        const isNgubotChannel = ngubotChannels.get(message.guild.id) === message.channel.id;
        const isMentioned = message.mentions.has(client.user) || 
                           message.content.toLowerCase().includes("ngubot") || 
                           message.content.includes("งูบอท");
        shouldRespond = isMentioned || (isNgubotChannel && isMessageDirectedAtBot(message.content));
    }

    if (shouldRespond) {
        if (!process.env.OPENROUTER_API_KEY) {
            try {
                await message.reply("❌ OpenRouter API key not configured!");
            } catch (error) {
                console.error("Error sending API key error message:", error);
            }
            return;
        }

        const question = isDM ? message.content : (message.content.replace(/<@!?\d+>/g, "").trim() || message.content);
        
        if (!question.trim()) {
            try {
                await message.reply("Hi! Ask me anything!");
            } catch (error) {
                console.error("Error sending greeting:", error);
            }
            return;
        }

        try {
            await message.channel.sendTyping();
            
            const completion = await openai.chat.completions.create({
                model: "meta-llama/llama-3.1-8b-instruct:free",
                messages: getConversationContext(message.channelId, message.guild, isDM),
                max_tokens: 500,
                temperature: 0.7,
            });

            const aiResponse = completion.choices[0]?.message?.content;
            if (!aiResponse) {
                await message.reply("🤔 I didn't get a response from the AI. Please try again.");
                return;
            }

            const finalResponse = await processAIResponse(aiResponse, message.guild, message.channelId, isDM);
            
            if (!finalResponse?.trim()) {
                await message.reply("🤔 I got a bit confused there. Could you try asking again?");
                return;
            }

            addToHistory(message.channelId, "assistant", finalResponse);
            
            const responseToSend = finalResponse.length > 1900 ? finalResponse.substring(0, 1900) + "..." : finalResponse;
            await message.reply(responseToSend);
            
        } catch (error) {
            console.error("Error in message processing:", error);
            try {
                await message.reply("❌ Sorry, I encountered an error while processing your request. Please try again later.");
            } catch (replyError) {
                console.error("Error sending error message:", replyError);
            }
        }
    }
});

// Error handling
client.on("error", (error) => {
    console.error("Discord client error:", error);
});

client.on("warn", (warning) => {
    console.warn("Discord client warning:", warning);
});

process.on("unhandledRejection", (error) => {
    console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down gracefully...");
    client.destroy();
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down gracefully...");
    client.destroy();
    process.exit(0);
});

// Login
if (!process.env.DISCORD_BOT_TOKEN) {
    console.error("❌ DISCORD_BOT_TOKEN not found in environment variables!");
    process.exit(1);
}

if (!process.env.OPENROUTER_API_KEY) {
    console.error("❌ OPENROUTER_API_KEY not found in environment variables!");
    process.exit(1);
}

client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
    console.error("Failed to login:", error);
    process.exit(1);
});
