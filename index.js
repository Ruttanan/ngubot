import discord
import asyncio
import aiohttp
from aiohttp import web
import os

# Set up intents for voice
intents = discord.Intents.default()
intents.voice_states = True
intents.guilds = True

bot = discord.Bot(intents=intents)

# Create a simple web server for health checks
async def health_check(request):
    return web.Response(text="Voice bot is alive!")

async def setup_webserver():
    app = web.Application()
    app.router.add_get('/', health_check)
    app.router.add_get('/ping', health_check)
    
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', int(os.environ.get('PORT', 8080)))
    await site.start()
    print("Web server started")

async def self_ping():
    await asyncio.sleep(60)  # Wait 1 minute before starting to ping
    while True:
        try:
            async with aiohttp.ClientSession() as session:
                # Replace with your actual Render URL
                url = "https://your-bot-name.onrender.com/ping"
                await session.get(url)
                print("Self-ping successful")
        except Exception as e:
            print(f"Self-ping failed: {e}")
        
        await asyncio.sleep(600)  # Ping every 10 minutes

@bot.event
async def on_ready():
    print(f'{bot.user} has connected to Discord!')
    print(f'Bot is in {len(bot.guilds)} guilds')
    
    # Start the web server
    await setup_webserver()
    # Start self-pinging
    asyncio.create_task(self_ping())

@bot.slash_command(name="join", description="Join a voice channel")
async def join_voice(ctx, channel_name: str = None):
    """Join a voice channel by name, or the user's current voice channel"""
    
    if channel_name:
        # Find channel by name
        voice_channel = discord.utils.get(ctx.guild.voice_channels, name=channel_name)
        if not voice_channel:
            await ctx.respond(f"Voice channel '{channel_name}' not found!")
            return
    else:
        # Join user's current voice channel
        if not ctx.author.voice:
            await ctx.respond("You're not in a voice channel! Please specify a channel name or join one first.")
            return
        voice_channel = ctx.author.voice.channel
    
    try:
        if ctx.voice_client:
            await ctx.voice_client.move_to(voice_channel)
            await ctx.respond(f"Moved to {voice_channel.name}")
        else:
            await voice_channel.connect()
            await ctx.respond(f"Joined {voice_channel.name}")
    except Exception as e:
        await ctx.respond(f"Failed to join voice channel: {str(e)}")

@bot.slash_command(name="leave", description="Leave the current voice channel")
async def leave_voice(ctx):
    """Leave the current voice channel"""
    
    if ctx.voice_client:
        await ctx.voice_client.disconnect()
        await ctx.respond("Left the voice channel")
    else:
        await ctx.respond("I'm not in a voice channel!")

@bot.slash_command(name="channels", description="List all voice channels in this server")
async def list_channels(ctx):
    """List all available voice channels"""
    
    voice_channels = ctx.guild.voice_channels
    if not voice_channels:
        await ctx.respond("No voice channels found in this server!")
        return
    
    channel_list = "\n".join([f"• {channel.name}" for channel in voice_channels])
    await ctx.respond(f"**Available voice channels:**\n{channel_list}")

# Run the bot
if __name__ == "__main__":
    bot.run(os.environ.get('DISCORD_TOKEN'))
