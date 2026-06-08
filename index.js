require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, Routes, REST, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');

// Save native fetch/Request before oci-sdk's isomorphic-fetch overrides them
const _nativeFetch = globalThis.fetch;
const _nativeRequest = globalThis.Request;
const _nativeResponse = globalThis.Response;

// If you see an error about the DAVE protocol, install the required package:
// npm install @snazzah/davey
const common = require('oci-sdk').common;
const objectStorage = require('oci-sdk').objectstorage;

// Restore native fetch so the SDK can send Readable stream bodies
if (_nativeFetch) globalThis.fetch = _nativeFetch;
if (_nativeRequest) globalThis.Request = _nativeRequest;
if (_nativeResponse) globalThis.Response = _nativeResponse;

const fs = require('fs');
const path = require('path');
const os = require('os');
const youtubedl = require('youtube-dl-exec');

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

function sanitizeFilename(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 80) || 'untitled';
}

async function uploadToBucket(localPath, objectName) {
    const buffer = fs.readFileSync(localPath);
    console.log('Uploading:', { objectName, namespaceName, bucketName, size: buffer.length });
    try {
        await ociClient.putObject({
            namespaceName,
            bucketName,
            objectName,
            putObjectBody: buffer,
            contentLength: buffer.length,
            contentType: 'audio/mpeg'
        });
    } catch (err) {
        console.error('OCI Upload Error:', err);
        console.error('Cause:', err.cause);
        throw err;
    }
}

function getFfmpegDir() {
    const binDir = path.join(os.tmpdir(), 'dmb_ffmpeg_bin');
    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
        const ffmpegSrc = require('ffmpeg-static');
        const ffprobeSrc = require('ffprobe-static').path;
        fs.copyFileSync(ffmpegSrc, path.join(binDir, path.basename(ffmpegSrc)));
        fs.copyFileSync(ffprobeSrc, path.join(binDir, path.basename(ffprobeSrc)));
    }
    return binDir;
}

async function ytdlp(url, flags, timeout = 120000) {
    const opts = {
        ffmpegLocation: getFfmpegDir(),
        jsRuntimes: 'node',
        socketTimeout: 30,
        retries: 3,
        ...flags
    };
    const cookiesFile = process.env['YT_COOKIES_FILE'];
    if (cookiesFile) {
        if (fs.existsSync(cookiesFile)) {
            opts.cookies = cookiesFile;
        } else {
            console.log('Cookies file not found:', cookiesFile);
        }
    }
    const proc = youtubedl.exec(url, opts);
    let output = '';
    proc.stderr.on('data', d => { const s = d.toString(); output += s; process.stdout.write(s); });
    const timer = timeout > 0 ? setTimeout(() => { proc.kill('SIGKILL'); }, timeout) : null;
    try {
        const result = await proc;
        if (result.exitCode !== 0) {
            throw Object.assign(new Error(output), result);
        }
        return result.stdout.trim();
    } finally {
        if (timer) clearTimeout(timer);
    }
}


const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates
	]
});



// Register /start and /shutdown commands on startup
client.once('clientReady', async () => {
	console.log(`Logged in as ${client.user.tag}`);
	try { await youtubedl.update(); console.log('yt-dlp updated'); } catch {}
	await fetchSongsFromBucket();
	const commands = [
		new SlashCommandBuilder().setName('start').setDescription('Music controls'),
		new SlashCommandBuilder().setName('shutdown').setDescription('Shut down the bot and delete temp files'),
		new SlashCommandBuilder().setName('refresh').setDescription('Refresh the song list from the bucket'),
		new SlashCommandBuilder()
			.setName('add')
			.setDescription('Download a YouTube video as MP3 and add it to the song library')
			.addStringOption(opt => opt.setName('url').setDescription('YouTube video URL').setRequired(true))
			.addStringOption(opt => opt.setName('name').setDescription('Custom song name (without .mp3)').setRequired(false)),
		new SlashCommandBuilder()
			.setName('remove')
			.setDescription('Remove a song from the song library')
			.addStringOption(opt => opt.setName('song').setDescription('The song to remove').setRequired(true).setAutocomplete(true)),
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
let player, connection, currentSongIndex = 0, tempPath = null, lastChannel = null, lastControlMessage = null;

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
        new ButtonBuilder().setCustomId('back').setLabel('Back').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pause').setLabel('Pause').setStyle(ButtonStyle.Secondary).setDisabled(!isPlaying),
        new ButtonBuilder().setCustomId('play').setLabel('Play').setStyle(ButtonStyle.Secondary).setDisabled(!isPaused),
        new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Secondary)
    );
}


// Handle /start, /shutdown, and /refresh commands
client.on('interactionCreate', async interaction => {
	if (interaction.isAutocomplete() && interaction.commandName === 'remove') {
		const focused = interaction.options.getFocused();
		const choices = songs
			.filter(s => s.title.toLowerCase().includes(focused.toLowerCase()))
			.slice(0, 25)
			.map(s => ({ name: s.title, value: s.title }));
		await interaction.respond(choices);
		return;
	}

	if (interaction.isChatInputCommand() && interaction.commandName === 'refresh') {
		const before = songs.length;
		await fetchSongsFromBucket();
		await interaction.reply({ content: `🔄 Song list refreshed! ${before} → ${songs.length} song(s) loaded.`, flags: MessageFlags.Ephemeral });
		return;
	}

	if (interaction.isChatInputCommand() && interaction.commandName === 'start') {
		const member = interaction.member;
		const voiceChannel = member && member.voice && member.voice.channel;
		if (!voiceChannel) {
			await interaction.reply({ content: 'You must be in a voice channel!', flags: MessageFlags.Ephemeral });
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
		await interaction.reply({ content: `Disconnected. Deleted ${deleted} temp files${failed ? ", failed to delete " + failed + "." : "."}`, flags: MessageFlags.Ephemeral });
	}

	if (interaction.isChatInputCommand() && interaction.commandName === 'add') {
		await interaction.deferReply();
		const url = interaction.options.getString('url');
		const customName = interaction.options.getString('name');
		const tempPath = './temp_download.mp3';
		try {
			try { fs.unlinkSync(tempPath); } catch {}
			let displayTitle, objectName;
			if (customName) {
				displayTitle = customName.replace(/[<>:"/\\|?*]/g, '_').replace(/\.mp3$/i, '').trim();
				objectName = sanitizeFilename(customName) + '.mp3';
			} else {
				console.log('Fetching title for:', url);
				displayTitle = (await ytdlp(url, { print: 'title' })).replace(/[<>:"/\\|?*]/g, '_').trim();
				console.log('Title:', displayTitle);
				objectName = sanitizeFilename(displayTitle) + '.mp3';
			}
			console.log('Downloading audio for:', displayTitle);
			await ytdlp(url, { format: 'bestaudio', mergeOutputFormat: 'mp3', audioQuality: 128, output: tempPath }, 300000);
			console.log('Download complete');
			const stats = fs.statSync(tempPath);
			const sizeMB = stats.size / (1024 * 1024);
			if (sizeMB > 15) {
				try { fs.unlinkSync(tempPath); } catch {}
				await interaction.editReply(`File exceeds 15 MB limit (${sizeMB.toFixed(1)} MB).`);
				return;
			}
			await uploadToBucket(tempPath, objectName);
			try { fs.unlinkSync(tempPath); } catch {}
			await fetchSongsFromBucket();
			await interaction.editReply(`Added **${displayTitle}** to the song library! (${sizeMB.toFixed(1)} MB)`);
		} catch (err) {
			try { fs.unlinkSync(tempPath); } catch {}
			console.error('Failed to add song:', err);
			await interaction.editReply(`Failed to add song: ${err.message}`);
		}
		return;
	}

	if (interaction.isChatInputCommand() && interaction.commandName === 'remove') {
		await interaction.deferReply();
		const songName = interaction.options.getString('song');
		const song = songs.find(s => s.title === songName);
		if (!song) {
			await interaction.editReply(`Song **${songName}** not found.`);
			return;
		}
		try {
			await ociClient.deleteObject({
				namespaceName,
				bucketName,
				objectName: song.ociPath
			});
			songs = songs.filter(s => s.ociPath !== song.ociPath);
			if (currentSongIndex >= songs.length) {
				currentSongIndex = Math.max(0, songs.length - 1);
			}
			await interaction.editReply(`Removed **${songName}** from the song library.`);
		} catch (err) {
			console.error('Failed to remove song:', err.message);
			await interaction.editReply(`Failed to remove song: ${err.message}`);
		}
		return;
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
		} else if (interaction.customId === 'shuffle') {
			const currentSong = songs[currentSongIndex];
			for (let i = songs.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[songs[i], songs[j]] = [songs[j], songs[i]];
			}
			currentSongIndex = songs.findIndex(s => s.ociPath === currentSong.ociPath);
			await updateControls(interaction);
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
	// Remove stale Idle listeners to prevent cascading auto-advances
	player.removeAllListeners(AudioPlayerStatus.Idle);
	player.once(AudioPlayerStatus.Idle, async () => {
		try { fs.unlinkSync(TEMP_SONG_PATH); } catch {}
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
		player.removeAllListeners(AudioPlayerStatus.Idle);
		player.once(AudioPlayerStatus.Idle, async () => {
			try { fs.unlinkSync(TEMP_SONG_PATH); } catch {}
			if (songs.length > 1) {
				await autoAdvance((nextIndex + 1) % songs.length);
			}
		});
		const payload = {
			content: `🎵 Now playing: **${song.title}**`,
			components: [buildSongSelectMenu(nextIndex), buildControlButtons(false, true)]
		};
		if (lastControlMessage) {
			try {
				await lastControlMessage.edit(payload);
			} catch {
				lastControlMessage = lastChannel ? await lastChannel.send(payload) : null;
			}
		} else if (lastChannel) {
			lastControlMessage = await lastChannel.send(payload);
		}
	} catch (e) {
		console.error('Failed to auto-advance to next song:', e);
	}
}

// Update the control UI based on player state
// Falls back to sending a fresh message if the interaction token has expired.
async function updateControls(interaction, songIndex = currentSongIndex, forcedState = null) {
    const isPaused = forcedState ? forcedState.isPaused : (player && player.state.status === AudioPlayerStatus.Paused);
    const isPlaying = forcedState ? forcedState.isPlaying : (player && player.state.status === AudioPlayerStatus.Playing);
    const payload = {
        content: `🎵 Now playing: **${songs[songIndex].title}**`,
        components: [buildSongSelectMenu(songIndex), buildControlButtons(isPaused, isPlaying)]
    };
    try {
        if (interaction.isRepliable()) {
            await interaction.update(payload);
            return;
        }
    } catch {}
    // Interaction token expired — send a fresh message so buttons stay functional.
    try {
        const channel = interaction.channel || lastChannel;
        if (channel) {
            const msg = await channel.send(payload);
            lastControlMessage = msg;
        }
    } catch {}
}

client.login(process.env.DISCORD_TOKEN);
