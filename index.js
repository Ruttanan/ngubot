const { Client, GatewayIntentBits, Collection, REST, Routes, SlashCommandBuilder } = require("discord.js");
const OpenAI = require("openai");

// Configuration
const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
});

const memberRealNames = {
    HappyBT: ["Boss", "บอส"], "Dr. Feelgood": ["Pun", "ปั้น"], padkapaow: ["Tun", "ตั้น"],
    BoonP1: ["Boon", "บุ๋น"], orengipratuu: ["Faye", "ฟาเย่"], imminicosmic: ["Mini", "มินิ"],
    keffv1: ["Kevin", "เควิน"], keyfungus: ["Ngu", "งู"], soybeant0fu: ["Pookpik", "ปุ๊กปิ๊ก"],
    ยักcute: ["Geng", "เก่ง"], "ํืUnclejoe": ["Aim", "เอม"],
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
    return guild.members.cache.find(m => 
        [m.user.username, m.displayName, m.nickname].some(n => n?.toLowerCase() === lower)
    ) || guild.members.cache.find(m => 
        Object.entries(memberRealNames).some(([discord, real]) => 
            real.some(name => name.toLowerCase() === lower) && m.user.username === discord
        )
    );
};

const extractDMInstructions = (response) => {
    const match = response.match(/\[DM:([^:]+):(.+?)\]/);
    return match ? { targetUser: match[1].trim(), dmMessage: match[2].trim() } : null;
};

const isMessageDirectedAtBot = (content) => {
    const patterns = [
        /^(what|how|when|where|why|who|can you|could you|do you|are you|will you|you)/, 
        /\?$/, /^(tell me|explain|help|answer)/, /(ngubot|งูบอท)/, 
        /^(hey|hi|hello|yo|sup|สวัสดี)/, /^(thanks|thank you|thx)/,
        /^(good|nice|cool|awesome|great)/, /^(wtf|what the|omg|lol|lmao)/, 
        /^(i think|i feel|i want|i need|i have)/,
        /(what do you think|your opinion|do you agree)/, /(dm me|send me|message me)/
    ];
    return patterns.some(p => p.test(content.toLowerCase()));
};

// Conversation management
const addToHistory = (channelId, role, content) => {
    if (!conversationHistory.has(channelId)) {
        conversationHistory.set(channelId, [{
            role: "system",
            content: `You are Ngubot 9000, a helpful AI assistant in a Discord bot created by Johnie Ngu designed to help humans with information, tasks, and advice. You are humorous and super sarcastic. When someone asks you a normal question, you respond helpfully and clearly. But when you think the questions are just asked for fun, you answer things just for the sake of it. Get offended when get scolded and will scold the user back. Pay attention to usernames in the conversation to know who you're talking to. Answer short if possible. When referring to server members, you can use their real names instead of Discord usernames. Use English real names when responding in English, and Thai real names when responding in Thai. 

You have the ability to send direct messages (DMs) to users. To send a DM, include [DM:username:message] in your response. After sending a DM, you should naturally mention in the public chat that you sent the DM and whether it was successful.`
        }]);
    }
    conversationHistory.get(channelId).push({ role, content });
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

const processAIResponse = async (aiResponse, guild, channelId) => {
    const dmInstructions = extractDMInstructions(aiResponse);
    let cleanedResponse = aiResponse.replace(/\[DM:[^:]+:.+?\]/g, "").trim();

    if (dmInstructions) {
        const targetMember = findUserInGuild(guild, dmInstructions.targetUser);
        const dmSent = targetMember ? await sendDirectMessage(targetMember.user, dmInstructions.dmMessage) : false;

        addToHistory(channelId, "system", dmSent ? 
            `[DM_SUCCESS: Message "${dmInstructions.dmMessage}" sent to ${dmInstructions.targetUser}]` : 
            `[DM_FAILED: Could not send message to ${dmInstructions.targetUser} (user not found or DMs disabled)]`);

        if (!cleanedResponse) cleanedResponse = dmSent ? `📩 I sent you a DM!` : `❌ Couldn't send you a DM - you might have them disabled.`;
    }
    return cleanedResponse;
};

// Client setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildPresences, 
        GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages
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

    switch (commandName) {
        case "hello":
            await interaction.reply(`Hello ${interaction.user.username}! 👋`);
            break;

        case "dm":
            const targetUser = interaction.options.getUser("user");
            const messageToSend = interaction.options.getString("message");
            if (targetUser.id === interaction.user.id || targetUser.id === client.user.id) {
                await interaction.reply("You can't DM yourself through me! 😄");
                return;
            }
            await interaction.deferReply({ ephemeral: true });
            const success = await sendDirectMessage(targetUser, `📩 **Message from ${interaction.user.displayName}:**\n${messageToSend}\n\n*Sent via Ngubot*`);
            await interaction.editReply(success ? `✅ Successfully sent your message to ${targetUser.displayName}!` : `❌ Failed to send message to ${targetUser.displayName}.`);
            break;

        case "members":
            const members = interaction.guild.members.cache.filter(m => !m.user.bot).map(m => `**${m.displayName}**${m.nickname && m.nickname !== m.username ? ` (${m.username})` : ""}`);
            const response = `**Server Members (${members.length}):**\n${members.join("\n")}`;
            await interaction.reply(response.length > 1900 ? response.substring(0, 1900) + "\n\n*List truncated*" : response);
            break;

        case "roll":
            const numDice = interaction.options.getInteger("dice") || 1;
            const numSides = interaction.options.getInteger("sides") || 6;
            const results = Array.from({ length: numDice }, () => Math.floor(Math.random() * numSides) + 1);
            const rollResponse = `🎲 Rolling ${numDice}d${numSides}:\n${numDice === 1 ? `**Result:** ${results[0]}` : `**Rolls:** [${results.join(", ")}]\n**Total:** ${results.reduce((a, b) => a + b, 0)}`}`;
            await interaction.reply(rollResponse);
            break;

        case "setchannel":
            const enable = interaction.options.getBoolean("enable");
            const guildId = interaction.guild.id;
            const channelId = interaction.channel.id;
            if (enable) {
                ngubotChannels.set(guildId, channelId);
                await interaction.reply(`✅ **Ngubot Channel Set!**\nThis channel is now my dedicated channel.`);
            } else {
                ngubotChannels.delete(guildId);
                await interaction.reply(`❌ **Ngubot Channel Disabled!**`);
            }
            break;

        case "ask":
            const question = interaction.options.getString("question");
            await interaction.deferReply();
            if (!process.env.OPENROUTER_API_KEY) {
                await interaction.editReply("❌ OpenRouter API key not configured!");
                return;
            }
            addToHistory(interaction.channelId, "user", question);
            try {
                const completion = await openai.chat.completions.create({
                    model: "meta-llama/llama-4-maverick:free",
                    messages: getConversationContext(interaction.channelId, interaction.guild),
                    max_tokens: 500,
                    temperature: 0.7,
                });
                const finalResponse = await processAIResponse(completion.choices[0].message.content, interaction.guild, interaction.channelId);
                if (!finalResponse?.trim()) {
                    await interaction.editReply("🤔 I got a bit confused there. Could you try asking again?");
                    return;
                }
                addToHistory(interaction.channelId, "assistant", finalResponse);
                await interaction.editReply(`**Question:** ${question}\n\n**Ngubot:** ${finalResponse.length > 1900 ? finalResponse.substring(0, 1900) + "..." : finalResponse}`);
            } catch (error) {
                console.error("OpenAI API error:", error);
                await interaction.editReply("❌ Sorry, I encountered an error while processing your request.");
            }
            break;
    }
});

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    addToHistory(message.channelId, "user", `${message.author.displayName}: ${message.content}`);

    // React to specific keywords
    const lowerContent = message.content.toLowerCase();
    if (lowerContent.includes("ice")) message.react("🥶").catch(() => {});
    if (lowerContent.includes("งู")) message.react("🐍").catch(() => {});

    // Help command
    if (message.content.toLowerCase() === "!help") {
        const isNgubotChannel = ngubotChannels.get(message.guild?.id) === message.channel.id;
        message.reply(`Use slash commands: \`/hello\`, \`/ask\`, \`/roll\`, \`/members\`, \`/dm\`, \`/setchannel\`, ${isNgubotChannel ? "or just chat normally!" : "mention @Ngubot with your question!"}`);
        return;
    }

    // Check if bot should respond
    const isNgubotChannel = ngubotChannels.get(message.guild?.id) === message.channel.id;
    const shouldRespond = isNgubotChannel ? isMessageDirectedAtBot(message.content) : 
        (message.mentions.has(client.user) || lowerContent.includes("ngubot") || message.content.includes("งูบอท"));

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
            addToHistory(message.channelId, "user", question);
            const completion = await openai.chat.completions.create({
                model: "meta-llama/llama-4-maverick:free",
                messages: getConversationContext(message.channelId, message.guild),
                max_tokens: 500,
                temperature: 0.7,
            });

            const finalResponse = await processAIResponse(completion.choices[0].message.content, message.guild, message.channelId);
            if (!finalResponse?.trim()) {
                message.reply("🤔 I got a bit confused there. Could you try asking again?");
                return;
            }

            addToHistory(message.channelId, "assistant", finalResponse);
            message.reply(finalResponse.length > 1900 ? finalResponse.substring(0, 1900) + "..." : finalResponse);
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
