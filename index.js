require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, Routes, REST } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');

// If you see an error about the DAVE protocol, install the required package:
// npm install @snazzah/davey
const common = require('oci-sdk').common;
const objectStorage = require('oci-sdk').objectstorage;
const fs = require('fs');

// Song list — populated dynamically from the OCI bucket at startup
let songs = [];

async function fetchSongsFromBucket() {
	try {
		const response = await ociClient.listObjects({ namespaceName, bucketName });
		const objects = response.listObjects.objects || [];
		songs = objects
			.filter(obj => /\.(mp3|wav|ogg|flac|aac)$/i.test(obj.name))
			.map(obj => ({
				title: obj.name.replace(/\.[^/.]+$/, ''),
				ociPath: obj.name
			}));
		console.log(`Loaded ${songs.length} song(s) from bucket:`, songs.map(s => s.title));
	} catch (err) {
		console.error('Failed to fetch songs from bucket:', err.message);
	}
}


// Oracle Cloud credentials from .env
const pemKeyPath = process.env['OCI-API-KEY'];
let privateKey;
try {
	privateKey = fs.readFileSync(pemKeyPath, 'utf8');
	console.log('Successfully loaded PEM key from:', pemKeyPath);
} catch (err) {
	console.error('Error reading PEM file:', err.message);
	console.error('Looking for file at:', pemKeyPath);
	process.exit(1);
}

const provider = new common.SimpleAuthenticationDetailsProvider(
	process.env['OCI-TENANCY-OCID'],
	process.env['OCI-USER-OCID'],
	process.env['OCI-FINGERPRINT'],
	privateKey,
	null,
	common.Region.fromRegionId(process.env['OCI-REGION'])
);
const ociClient = new objectStorage.ObjectStorageClient({ authenticationDetailsProvider: provider });
const bucketName = 'discord-bot-audio';
const namespaceName = process.env.OCI_NAMESPACE;

// Cache for downloaded songs: { ociPath: tempFilePath }
const songCache = {};

// Use a single temp file for all songs
const TEMP_SONG_PATH = './temp_song.mp3';

// Download an audio file from Oracle Object Storage and save to the single temp file
async function downloadSongToTemp(ociPath) {
    const getObjReq = {
        namespaceName,
        bucketName,
        objectName: ociPath
    };
    const response = await ociClient.getObject(getObjReq);
    if (Buffer.isBuffer(response.value)) {
        fs.writeFileSync(TEMP_SONG_PATH, response.value);
    } else if (typeof response.value.getReader === 'function') {
        // Web ReadableStream: convert to Buffer
        const reader = response.value.getReader();
        const chunks = [];
        let done, value;
        while (({ done, value } = await reader.read()), !done) {
            chunks.push(Buffer.from(value));
        }
        fs.writeFileSync(TEMP_SONG_PATH, Buffer.concat(chunks));
    } else {
        throw new Error('Unknown response.value type');
    }
    return TEMP_SONG_PATH;
}


const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates
	]
});



// Register /start and /shutdown commands on startup
client.once('ready', async () => {
	console.log(`Logged in as ${client.user.tag}`);
	await fetchSongsFromBucket();
	const commands = [
		new SlashCommandBuilder().setName('start').setDescription('Music controls'),
		new SlashCommandBuilder().setName('shutdown').setDescription('Shut down the bot and delete temp files'),
		new SlashCommandBuilder().setName('refresh').setDescription('Refresh the song list from the bucket'),
	].map(cmd => cmd.toJSON());
	const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
	try {
		await rest.put(
			Routes.applicationCommands(client.user.id),
			{ body: commands }
		);
		console.log('Slash commands registered');
	} catch (err) {
		console.error('Failed to register slash commands:', err);
	}
});

// Music player state
let player, connection, currentSongIndex = 0, tempPath = null, lastChannel = null;

const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');

// Helper to build the song select menu
function buildSongSelectMenu(selectedIndex = 0) {
	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId('select_song')
			.setPlaceholder('Choose a song')
			.addOptions(songs.map((song, i) => ({
				label: song.title,
				value: i.toString(),
				default: i === selectedIndex
			})))
	);
}

// Helper to build control buttons
function buildControlButtons(isPaused = false, isPlaying = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('back').setLabel('⏮️ Back').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('pause').setLabel('⏸️ Pause').setStyle(ButtonStyle.Secondary).setDisabled(!isPlaying),
        new ButtonBuilder().setCustomId('play').setLabel('▶️ Play').setStyle(ButtonStyle.Success).setDisabled(!isPaused),
        new ButtonBuilder().setCustomId('skip').setLabel('⏭️ Skip').setStyle(ButtonStyle.Primary)
    );
}


// Handle /start, /shutdown, and /refresh commands
client.on('interactionCreate', async interaction => {
	if (interaction.isChatInputCommand() && interaction.commandName === 'refresh') {
		const before = songs.length;
		await fetchSongsFromBucket();
		await interaction.reply({ content: `🔄 Song list refreshed! ${before} → ${songs.length} song(s) loaded.`, ephemeral: true });
		return;
	}

	if (interaction.isChatInputCommand() && interaction.commandName === 'start') {
		const member = interaction.member;
		const voiceChannel = member && member.voice && member.voice.channel;
		if (!voiceChannel) {
			await interaction.reply({ content: 'You must be in a voice channel!', ephemeral: true });
			return;
		}
		// Join the voice channel immediately
		if (!connection || connection.joinConfig.channelId !== voiceChannel.id) {
			if (connection) connection.destroy();
			connection = joinVoiceChannel({
				channelId: voiceChannel.id,
				guildId: voiceChannel.guild.id,
				adapterCreator: voiceChannel.guild.voiceAdapterCreator,
			});
		}
		// Play the first song automatically
		currentSongIndex = 0;
		await playSong(interaction, currentSongIndex, true);
	}

	if (interaction.isChatInputCommand() && interaction.commandName === 'shutdown') {
		// Disconnect from VC if connected
		if (player) {
			try { player.stop(true); } catch {}
			player = null;
		}
		// Wait to ensure file handles are released
		await new Promise(res => setTimeout(res, 1000));
		if (connection) {
			connection.destroy();
			connection = null;
		}
		// Wait briefly to ensure files are released
		await new Promise(res => setTimeout(res, 500));
		// Delete all temp_*.mp3 files (async, robust)
		const dir = process.cwd();
		let deleted = 0, failed = 0;
		try {
			const files = await fs.promises.readdir(dir);
			await Promise.all(files.filter(f => /^temp_.*\.mp3$/.test(f)).map(async f => {
				try {
					await fs.promises.unlink(`${dir}/${f}`);
					deleted++;
				} catch (e) {
					failed++;
				}
			}));
		} catch {}
		// Clear cache
		for (const key in songCache) delete songCache[key];
		await interaction.reply({ content: `Disconnected. Deleted ${deleted} temp files${failed ? ", failed to delete " + failed + "." : "."}`, ephemeral: true });
	}

	// Handle song selection
	if (interaction.isStringSelectMenu() && interaction.customId === 'select_song') {
		currentSongIndex = parseInt(interaction.values[0]);
		await playSong(interaction);
	}

	// Handle button controls
	if (interaction.isButton()) {
		if (interaction.customId === 'skip') {
			currentSongIndex = (currentSongIndex + 1) % songs.length;
			await playSong(interaction);
		} else if (interaction.customId === 'pause') {
			if (player && player.state.status === AudioPlayerStatus.Playing) {
				player.pause();
			}
			await updateControls(interaction);
		} else if (interaction.customId === 'play') {
			if (player && player.state.status === AudioPlayerStatus.Paused) {
				player.unpause();
			}
			await updateControls(interaction);
		} else if (interaction.customId === 'back') {
			if (player && player.state.status === AudioPlayerStatus.Playing) {
				// If >5s into song, restart; else go to previous
				const resource = player.state.resource;
				if (resource && resource.playbackDuration > 5000 && tempPath) {
					player.stop();
					await playSong(interaction, currentSongIndex);
				} else {
					currentSongIndex = (currentSongIndex - 1 + songs.length) % songs.length;
					await playSong(interaction);
				}
			} else {
				currentSongIndex = (currentSongIndex - 1 + songs.length) % songs.length;
				await playSong(interaction);
			}
		}
	}
});

// Play the selected song
async function playSong(interaction, songIndex = currentSongIndex, isInitial = false) {
	// Clean up previous temp file
	try { fs.unlinkSync(TEMP_SONG_PATH); } catch {}
	// Download song
	const song = songs[songIndex];
	tempPath = await downloadSongToTemp(song.ociPath);
	// Join or reuse connection
	if (!connection || connection.joinConfig.channelId !== interaction.member.voice.channel.id) {
		if (connection && connection.state.status !== 'destroyed') {
			connection.destroy();
		}
		connection = joinVoiceChannel({
			channelId: interaction.member.voice.channel.id,
			guildId: interaction.member.voice.channel.guild.id,
			adapterCreator: interaction.member.voice.channel.guild.voiceAdapterCreator,
		});
	}
	// Create or reuse player
	if (!player) {
		player = createAudioPlayer({
			behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
		});
		connection.subscribe(player);
	}
	const resource = createAudioResource(TEMP_SONG_PATH);
	player.play(resource);
	player.once(AudioPlayerStatus.Idle, async () => {
		try { fs.unlinkSync(TEMP_SONG_PATH); } catch {}
		// Auto-play next song if available
		if (songs.length > 1) {
			await autoAdvance((songIndex + 1) % songs.length);
		}
	});
	// Store the channel for auto-advance messages
	if (interaction.channel) lastChannel = interaction.channel;
	// Update UI
	if (isInitial) {
		await interaction.reply({
			content: `🎵 Now playing: **${songs[songIndex].title}**`,
			components: [buildSongSelectMenu(songIndex), buildControlButtons(false, true)]
		});
	} else {
		await updateControls(interaction, songIndex, { isPaused: false, isPlaying: true });
	}
}

// Auto-advance to next song without needing an interaction object
async function autoAdvance(nextIndex) {
	currentSongIndex = nextIndex;
	const song = songs[nextIndex];
	try {
		try { fs.unlinkSync(TEMP_SONG_PATH); } catch {}
		await downloadSongToTemp(song.ociPath);
		const resource = createAudioResource(TEMP_SONG_PATH);
		player.play(resource);
		player.once(AudioPlayerStatus.Idle, async () => {
			try { fs.unlinkSync(TEMP_SONG_PATH); } catch {}
			if (songs.length > 1) {
				await autoAdvance((nextIndex + 1) % songs.length);
			}
		});
		if (lastChannel) {
			await lastChannel.send({
				content: `🎵 Now playing: **${song.title}**`,
				components: [buildSongSelectMenu(nextIndex), buildControlButtons(false, true)]
			});
		}
	} catch (e) {
		console.error('Failed to auto-advance to next song:', e);
	}
}

// Update the control UI based on player state
async function updateControls(interaction, songIndex = currentSongIndex, forcedState = null) {
    const isPaused = forcedState ? forcedState.isPaused : (player && player.state.status === AudioPlayerStatus.Paused);
    const isPlaying = forcedState ? forcedState.isPlaying : (player && player.state.status === AudioPlayerStatus.Playing);
    if (interaction.isRepliable()) {
        await interaction.update({
            content: `🎵 Now playing: **${songs[songIndex].title}**`,
            components: [buildSongSelectMenu(songIndex), buildControlButtons(isPaused, isPlaying)]
        });
    }
}

client.once('ready', () => {
	console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
