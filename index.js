const { Client, GatewayIntentBits, Collection, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceConnectionStatus, AudioPlayerStatus } = require("@discordjs/voice");
const express = require('express');

// Express setup for Render.com
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Voice Bot is running! 🔊');
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
});

// Global state for voice connections
const voiceConnections = new Map();

// Commands
const commands = [
    new SlashCommandBuilder()
        .setName("join")
        .setDescription("Join your current voice channel"),
    
    new SlashCommandBuilder()
        .setName("joinvc")
        .setDescription("Join a specific voice channel")
        .addChannelOption(option => 
            option.setName("channel")
                .setDescription("The voice channel to join")
                .setRequired(true)
        ),
    
    new SlashCommandBuilder()
        .setName("leave")
        .setDescription("Leave the current voice channel"),
    
    new SlashCommandBuilder()
        .setName("move")
        .setDescription("Move to a different voice channel")
        .addChannelOption(option => 
            option.setName("channel")
                .setDescription("The voice channel to move to")
                .setRequired(true)
        ),
    
    new SlashCommandBuilder()
        .setName("status")
        .setDescription("Check voice connection status")
];

// Utility functions
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

// Voice connection functions
const joinVoiceChannelHandler = async (voiceChannel, guildId) => {
    try {
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guildId,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });

        // Store the connection
        voiceConnections.set(guildId, connection);

        // Handle connection events
        connection.on(VoiceConnectionStatus.Ready, () => {
            console.log(`Successfully joined voice channel: ${voiceChannel.name}`);
        });

        connection.on(VoiceConnectionStatus.Disconnected, () => {
            console.log(`Disconnected from voice channel in guild: ${guildId}`);
            voiceConnections.delete(guildId);
        });

        connection.on('error', (error) => {
            console.error('Voice connection error:', error);
        });

        return connection;
    } catch (error) {
        console.error('Error joining voice channel:', error);
        return null;
    }
};

const leaveVoiceChannel = (guildId) => {
    const connection = voiceConnections.get(guildId);
    if (connection) {
        connection.destroy();
        voiceConnections.delete(guildId);
        return true;
    }
    return false;
};

// Client setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages
    ],
});

// Event handlers
client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    
    try {
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

    try {
        switch (commandName) {
            case "join":
                // Get user's current voice channel
                const userVoiceChannel = interaction.member?.voice?.channel;
                
                if (!userVoiceChannel) {
                    await safeReply(interaction, "❌ You need to be in a voice channel for me to join!");
                    return;
                }

                await safeDeferReply(interaction);
                
                const connection = await joinVoiceChannelHandler(userVoiceChannel, interaction.guild.id);
                
                if (connection) {
                    await safeReply(interaction, `✅ Successfully joined **${userVoiceChannel.name}**!`);
                } else {
                    await safeReply(interaction, "❌ Failed to join the voice channel. Please check permissions.");
                }
                break;

            case "joinvc":
                const targetChannel = interaction.options.getChannel("channel");
                
                if (targetChannel.type !== 2) { // 2 = Voice Channel
                    await safeReply(interaction, "❌ Please select a voice channel!");
                    return;
                }

                await safeDeferReply(interaction);
                
                const joinConnection = await joinVoiceChannelHandler(targetChannel, interaction.guild.id);
                
                if (joinConnection) {
                    await safeReply(interaction, `✅ Successfully joined **${targetChannel.name}**!`);
                } else {
                    await safeReply(interaction, "❌ Failed to join the voice channel. Please check permissions.");
                }
                break;

            case "leave":
                const leftChannel = leaveVoiceChannel(interaction.guild.id);
                
                if (leftChannel) {
                    await safeReply(interaction, "✅ Successfully left the voice channel!");
                } else {
                    await safeReply(interaction, "❌ I'm not currently in a voice channel!");
                }
                break;

            case "move":
                const moveToChannel = interaction.options.getChannel("channel");
                
                if (moveToChannel.type !== 2) {
                    await safeReply(interaction, "❌ Please select a voice channel!");
                    return;
                }

                await safeDeferReply(interaction);
                
                // Leave current channel first
                leaveVoiceChannel(interaction.guild.id);
                
                // Join new channel
                const moveConnection = await joinVoiceChannelHandler(moveToChannel, interaction.guild.id);
                
                if (moveConnection) {
                    await safeReply(interaction, `✅ Successfully moved to **${moveToChannel.name}**!`);
                } else {
                    await safeReply(interaction, "❌ Failed to move to the voice channel. Please check permissions.");
                }
                break;

            case "status":
                const currentConnection = voiceConnections.get(interaction.guild.id);
                
                if (currentConnection) {
                    const status = currentConnection.state.status;
                    const channelId = currentConnection.joinConfig.channelId;
                    const channel = interaction.guild.channels.cache.get(channelId);
                    
                    await safeReply(interaction, 
                        `🔊 **Voice Status:**\n` +
                        `Connected to: **${channel?.name || 'Unknown Channel'}**\n` +
                        `Status: **${status}**`
                    );
                } else {
                    await safeReply(interaction, "❌ Not currently connected to any voice channel.");
                }
                break;
        }
    } catch (error) {
        console.error(`Error handling ${commandName} command:`, error);
        if (error.code !== 10062) {
            try {
                await safeReply(interaction, "❌ Sorry, something went wrong while processing your command.");
            } catch (e) {
                console.error("Failed to send error message:", e);
            }
        }
    }
});

// Auto-leave when alone in voice channel
client.on('voiceStateUpdate', (oldState, newState) => {
    const guildId = oldState.guild.id;
    const connection = voiceConnections.get(guildId);
    
    if (!connection) return;
    
    const channelId = connection.joinConfig.channelId;
    const voiceChannel = oldState.guild.channels.cache.get(channelId);
    
    if (voiceChannel) {
        const members = voiceChannel.members.filter(member => !member.user.bot);
        
        // Leave if no human members left
        if (members.size === 0) {
            console.log(`Leaving ${voiceChannel.name} - no members left`);
            leaveVoiceChannel(guildId);
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
