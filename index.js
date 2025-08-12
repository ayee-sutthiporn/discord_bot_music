require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  getVoiceConnection,
  demuxProbe,
  StreamType,
} = require("@discordjs/voice");

const play = require("play-dl");
const ytdl = require("@distube/ytdl-core");
const ytdlp = require("youtube-dl-exec");
const { spawn } = require("child_process");
const ffmpeg = require("ffmpeg-static");

// ---------- Config ----------
const PLAYLIST_MAX = Number(process.env.PLAYLIST_MAX ?? 100);
const CAT_NAME = "CozyCat🐱";

// ---------- CozyCat helper ----------
function catEmbed({ title, description, color = 0x00aaff, footer, thumbnail }) {
  const eb = new EmbedBuilder()
    .setTitle(`${CAT_NAME} | ${title}`)
    .setDescription(description)
    .setColor(color);
  if (thumbnail) eb.setThumbnail(thumbnail);
  if (footer) eb.setFooter({ text: footer });
  return eb;
}

// ---------- Optional: YouTube cookie ----------
if (process.env.YT_COOKIE) {
  play.setToken({ youtube: { cookie: process.env.YT_COOKIE } });
  console.log("🍪 YouTube cookie loaded");
}

// ---------- play-dl setup ----------
try {
  play
    .getFreeClientID()
    .then((clientID) => {
      play.setToken({ soundcloud: { client_id: clientID } });
    })
    .catch(() => console.warn("Could not get SoundCloud client ID"));
} catch (e) {
  console.warn("play-dl setup warning:", e.message);
}

// ---------- Client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ---------- State ----------
const states = new Map(); // guildId -> { queue:[], player, textChannel, loop:false, volume:1.0 }

function ensureState(gid) {
  if (!states.has(gid)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    const st = {
      queue: [],
      player,
      textChannel: null,
      loop: false,
      volume: 1.0,
    };

    player.on(AudioPlayerStatus.Idle, () => {
      if (st.queue.length) {
        const finished = st.queue.shift();
        if (st.loop) st.queue.push(finished);
      }
      if (st.queue[0]) playNext(gid).catch(console.error);
    });

    player.on("error", (e) => console.error("[Player error]", e));
    states.set(gid, st);
  }
  return states.get(gid);
}

// ---------- Utils ----------
async function resolveInput(q) {
  console.log("[resolveInput] Processing:", q);

  if (play.yt_validate(q) === "playlist") {
    const pl = await play.playlist_info(q, { incomplete: true });
    const all = await pl.all_videos();
    if (!all?.length) throw new Error("Empty playlist");

    const sliced = all.slice(0, PLAYLIST_MAX);
    const items = sliced.map((v) => ({
      title: v.title || "Unknown Title",
      url: v.url,
      info: null,
    }));

    return {
      kind: "playlist",
      title: pl.title || "Playlist",
      items,
      total: all.length,
    };
  }

  if (play.yt_validate(q) === "video") {
    const info = await play.video_info(q);
    if (!info?.video_details) throw new Error("Could not get video info");
    return {
      kind: "single",
      items: [
        {
          title: info.video_details.title || "Unknown Title",
          url: info.video_details.url || q,
          info,
        },
      ],
    };
  }

  const results = await play.search(q, {
    limit: 3,
    source: { youtube: "video" },
  });
  if (!results?.length) throw new Error("No search result");

  for (let i = 0; i < results.length; i++) {
    try {
      const info = await play.video_info(results[i].url);
      if (info?.video_details?.url) {
        return {
          kind: "single",
          items: [
            {
              title: info.video_details.title || results[i].title || "Unknown",
              url: info.video_details.url || results[i].url,
              info,
            },
          ],
        };
      }
    } catch (err) {
      console.warn(`[resolveInput] candidate ${i} failed:`, err.message);
    }
  }
  throw new Error("Could not resolve any valid video from search results");
}

/** yt-dlp + ffmpeg → PCM (Raw) */
async function streamWithYtDlp(testUrl) {
  const opts = {
    getUrl: true,
    noPlaylist: true,
    noWarnings: true,
    rmCacheDir: true,
  };
  if (process.env.YT_COOKIE)
    opts.addHeader = [`cookie: ${process.env.YT_COOKIE}`];

  const out = await ytdlp(testUrl, opts);
  const direct = String(out).trim().split("\n")[0];
  if (!direct) throw new Error("yt-dlp: empty direct url");

  const ff = spawn(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-i",
    direct,
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "pipe:1",
  ]);

  ff.stderr.on("data", (d) => console.warn("[ffmpeg]", d.toString()));
  ff.on("close", (code) => console.log("[ffmpeg] exit", code));

  return { stream: ff.stdout, type: StreamType.Raw };
}

/** สร้างสตรีม: play-dl → @distube/ytdl-core → yt-dlp */
async function createStreamSafely(videoInfo) {
  const urls = [
    videoInfo?.video_details?.url,
    videoInfo?.video_details?.webpage_url,
    videoInfo?.video_details?.id
      ? `https://www.youtube.com/watch?v=${videoInfo.video_details.id}`
      : null,
    videoInfo?.url,
  ].filter(Boolean);

  // 1) play-dl
  for (const testUrl of urls) {
    try {
      const s1 = await play.stream(testUrl, {
        quality: 1,
        discordPlayerCompatibility: true,
      });
      if (s1?.stream) return s1;
    } catch {}
    try {
      if (play.yt_validate(testUrl) === "video") {
        const fresh = await play.video_info(testUrl);
        const s2 = await play.stream_from_info(fresh, {
          quality: 1,
          discordPlayerCompatibility: true,
        });
        if (s2?.stream) return s2;
      }
    } catch {}
  }

  // 2) ytdl-core fork
  for (const testUrl of urls) {
    if (!ytdl.validateURL(testUrl)) continue;
    try {
      const ytdlStream = ytdl(testUrl, {
        quality: "highestaudio",
        filter: "audioonly",
        highWaterMark: 1 << 25,
        requestOptions: process.env.YT_COOKIE
          ? { headers: { cookie: process.env.YT_COOKIE } }
          : {},
      });
      const probe = await demuxProbe(ytdlStream);
      return { stream: probe.stream, type: probe.type ?? StreamType.Arbitrary };
    } catch {}
  }

  // 3) yt-dlp
  for (const testUrl of urls) {
    try {
      return await streamWithYtDlp(testUrl);
    } catch {}
  }

  // search last resort
  const title = videoInfo?.video_details?.title;
  if (title) {
    const results = await play.search(title, {
      limit: 1,
      source: { youtube: "video" },
    });
    if (results?.length) {
      try {
        const fresh = await play.video_info(results[0].url);
        const s3 = await play.stream_from_info(fresh, {
          quality: 1,
          discordPlayerCompatibility: true,
        });
        if (s3?.stream) return s3;
      } catch {}
      if (ytdl.validateURL(results[0].url)) {
        try {
          const ys = ytdl(results[0].url, {
            quality: "highestaudio",
            filter: "audioonly",
            highWaterMark: 1 << 25,
            requestOptions: process.env.YT_COOKIE
              ? { headers: { cookie: process.env.YT_COOKIE } }
              : {},
          });
          const probe2 = await demuxProbe(ys);
          return {
            stream: probe2.stream,
            type: probe2.type ?? StreamType.Arbitrary,
          };
        } catch {}
      }
      try {
        return await streamWithYtDlp(results[0].url);
      } catch {}
    }
  }

  throw new Error("All stream creation methods failed");
}

/** เล่นเพลงหัวคิว */
async function playNext(guildId) {
  const st = ensureState(guildId);
  const item = st.queue[0];
  if (!item) return;

  try {
    let info = item.info;
    if (!info || !info.video_details) {
      if (item.url && play.yt_validate(item.url) === "video") {
        info = await play.video_info(item.url);
      } else {
        throw new Error("No valid URL for getting video info");
      }
    }
    if (!info?.video_details) throw new Error("Could not get video info");

    const stream = await createStreamSafely(info);
    if (!stream?.stream)
      throw new Error("Could not create stream from video info");

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: stream.type === StreamType.Raw,
    });
    if (stream.type === StreamType.Raw) resource.volume.setVolume(st.volume);

    st.player.play(resource);

    if (st.textChannel) {
      await st.textChannel.send({
        embeds: [
          catEmbed({
            title: "กำลังเล่น 🎧",
            description: `**${info.video_details.title}**\n[ลิงก์](${info.video_details.url})`,
            thumbnail: info.video_details.thumbnails?.[0]?.url || null,
            color: 0x00ff88,
            footer: `คิวที่เหลือ: ${Math.max(
              0,
              st.queue.length - 1
            )} • วนซ้ำ: ${st.loop ? "เปิด" : "ปิด"} • เมี๊ยว~`,
          }),
        ],
      });
    }
  } catch (err) {
    console.error("[playNext error]", err);
    // ข้ามเพลงที่มีปัญหา
    states.get(guildId).queue.shift();
    if (states.get(guildId).textChannel) {
      await states.get(guildId).textChannel.send({
        embeds: [
          catEmbed({
            title: "ข้ามเพลงนะ ❌",
            description: `เล่น **${
              item.title || "เพลงนี้"
            }** ไม่ได้ ข้ามให้แล้วน้า~`,
            color: 0xff3355,
          }),
        ],
      });
    }
    if (states.get(guildId).queue.length) return playNext(guildId);
  }
}

// ---------- Slash Commands ----------
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName("join")
      .setDescription("ให้บอทเข้าช่องเสียงของคุณ"),
    new SlashCommandBuilder()
      .setName("play")
      .setDescription("เปิดเพลงจากลิงก์หรือคำค้นหา (รองรับ Playlist)")
      .addStringOption((o) =>
        o
          .setName("q")
          .setDescription("YouTube URL / Playlist / คำค้นหา")
          .setRequired(true)
      ),
    new SlashCommandBuilder().setName("skip").setDescription("ข้ามเพลง"),
    new SlashCommandBuilder()
      .setName("jump")
      .setDescription("ข้ามไปยังเพลงหมายเลขที่ต้องการ (อ้างอิงจาก /queue)")
      .addIntegerOption((o) =>
        o
          .setName("pos")
          .setDescription("หมายเลขเพลงในคิว (เริ่มที่ 1)")
          .setRequired(true)
          .setMinValue(1)
      ),
    new SlashCommandBuilder()
      .setName("remove")
      .setDescription("ลบเพลงหมายเลขที่ไม่ต้องการออกจากคิว")
      .addIntegerOption((o) =>
        o
          .setName("pos")
          .setDescription("หมายเลขเพลงในคิว (เริ่มที่ 1)")
          .setRequired(true)
          .setMinValue(1)
      ),
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("ลบเพลงทั้งหมดในคิว (ยกเว้นเพลงที่กำลังเล่น)"),
    new SlashCommandBuilder()
      .setName("clearall")
      .setDescription("ลบคิวทั้งหมดและหยุดเล่น"),
    new SlashCommandBuilder().setName("pause").setDescription("พักเพลง"),
    new SlashCommandBuilder().setName("resume").setDescription("เล่นต่อ"),
    new SlashCommandBuilder().setName("stop").setDescription("หยุดและล้างคิว"),
    new SlashCommandBuilder().setName("queue").setDescription("ดูคิวเพลง"),
    new SlashCommandBuilder().setName("np").setDescription("เพลงที่กำลังเล่น"),
    new SlashCommandBuilder().setName("shuffle").setDescription("สลับคิวสุ่ม"),
    new SlashCommandBuilder()
      .setName("loop")
      .setDescription("สลับโหมดวนซ้ำคิวทั้งหมด"),
    new SlashCommandBuilder()
      .setName("vol")
      .setDescription("ตั้งเสียง 1-200%")
      .addIntegerOption((o) =>
        o
          .setName("percent")
          .setDescription("เปอร์เซ็นต์เสียง")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("ให้ออกจากช่องเสียง"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  if (process.env.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
      { body: cmds }
    );
    console.log("✅ Registered GUILD slash commands.");
  } else {
    await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
    console.log("✅ Registered GLOBAL slash commands (อาจใช้เวลาปรากฏ).");
  }
}

// ---------- Ready ----------
client.once("ready", async () => {
  console.log(`🎵 Logged in as ${client.user.tag}`);
  console.log(
    `🔗 Invite link: https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=3165184&scope=bot%20applications.commands`
  );
  try {
    await registerCommands();
  } catch (e) {
    console.error("Register commands error", e);
  }
});

// ---------- Helpers ----------
function needSameVC(ix) {
  const userVC = ix.member?.voice?.channel;
  if (!userVC) {
    ix.reply({
      content: "🐾 เมี๊ยว~ เข้าห้องเสียงก่อนนะ ถึงจะไปเล่นเพลงให้ได้!",
      ephemeral: true,
    }).catch(() => {});
    return null;
  }
  const conn = getVoiceConnection(ix.guildId);
  if (conn && conn.joinConfig.channelId !== userVC.id) {
    ix.reply({
      content:
        "😽 เมี๊ยว? อยู่คนละห้องกัน ใช้ `/join` เรียก CozyCat มาหาก่อนน้า~",
      ephemeral: true,
    }).catch(() => {});
    return null;
  }
  return userVC;
}

// ---------- Handlers ----------
client.on("interactionCreate", async (ix) => {
  if (!ix.isChatInputCommand()) return;
  const st = ensureState(ix.guildId);

  try {
    // /join
    if (ix.commandName === "join") {
      const vc = needSameVC(ix);
      if (!vc) return;
      const conn =
        getVoiceConnection(ix.guildId) ||
        joinVoiceChannel({
          channelId: vc.id,
          guildId: vc.guild.id,
          adapterCreator: vc.guild.voiceAdapterCreator,
          selfDeaf: true,
        });
      conn.subscribe(st.player);
      st.textChannel = ix.channel;
      return ix.reply(
        `🎀 ${CAT_NAME} กระโดดเข้าห้อง **${vc.name}** แล้วนะ เมี๊ยว~`
      );
    }

    // /play
    if (ix.commandName === "play") {
      const vc = needSameVC(ix);
      if (!vc) return;
      const conn =
        getVoiceConnection(ix.guildId) ||
        joinVoiceChannel({
          channelId: vc.id,
          guildId: vc.guild.id,
          adapterCreator: vc.guild.voiceAdapterCreator,
          selfDeaf: true,
        });
      conn.subscribe(st.player);
      st.textChannel = ix.channel;

      const q = ix.options.getString("q", true).trim();
      await ix.deferReply();

      try {
        const resolved = await resolveInput(q);

        if (resolved.kind === "playlist") {
          const before = st.queue.length;
          st.queue.push(...resolved.items);
          const added = st.queue.length - before;

          if (st.player.state.status !== AudioPlayerStatus.Playing) {
            playNext(ix.guildId).catch(console.error);
          }

          const preview = resolved.items
            .slice(0, 10)
            .map((it, i) => `**${i + 1}.** ${it.title}`)
            .join("\n");
          const more =
            resolved.total > added
              ? ` (เพิ่มแล้ว ${added}/${resolved.total})`
              : "";

          await ix.editReply({
            embeds: [
              catEmbed({
                title: "เพิ่มเพลย์ลิสต์เข้าคิวแล้ว 📃",
                description: `**${resolved.title}**\nCozyCat หอบเพลงมาให้ฟังเพียบเลย~${more}`,
                color: 0x00aaff,
                footer: `คิวรวมตอนนี้: ${st.queue.length} รายการ`,
              }).addFields({
                name: "ตัวอย่าง",
                value: preview || "-",
                inline: false,
              }),
            ],
          });
          return;
        }

        const item = resolved.items[0];
        if (!item?.url) {
          return ix.editReply({
            embeds: [
              catEmbed({
                title: "โอ๊ะ! ลิงก์งอแง 😿",
                description:
                  "CozyCat ดึงลิงก์เพลงไม่สำเร็จ ลองใช้ลิงก์ YouTube อื่นหรือเปลี่ยนคำค้นหานะ",
                color: 0xff3355,
              }),
            ],
          });
        }

        st.queue.push(item);

        await ix.editReply({
          embeds: [
            catEmbed({
              title: "เก็บเพลงเข้าคิวแล้ว ➕",
              description: `**${item.title}**\n[ลิงก์](${item.url})\nเมี๊ยว~ เตรียมฟังได้เลย`,
              thumbnail: item.info?.video_details?.thumbnails?.[0]?.url || null,
              color: 0x00ff88,
              footer: `ตำแหน่งในคิว: ${st.queue.length} • รอคิว: ${Math.max(
                0,
                st.queue.length - 1
              )}`,
            }),
          ],
        });

        if (st.player.state.status !== AudioPlayerStatus.Playing) {
          await playNext(ix.guildId);
        }
      } catch (e) {
        console.error("[play command error]", e);
        await ix.editReply({
          embeds: [
            catEmbed({
              title: "ขนฟูเลย… มีข้อผิดพลาด 😿",
              description:
                "CozyCat หา/โหลดเพลงไม่สำเร็จ ลองใช้ลิงก์ YouTube ตรง ๆ หรือเปลี่ยนคำค้นหาดูนะ",
              color: 0xff3355,
            }).addFields({
              name: "รายละเอียด",
              value: `\`${e.message}\``,
              inline: false,
            }),
          ],
        });
      }
      return;
    }

    // /skip
    if (ix.commandName === "skip") {
      if (!st.queue.length)
        return ix.reply({
          content: "เมี๊ยว~ ตอนนี้คิวว่าง ไม่มีเพลงให้ข้ามนะ",
          ephemeral: true,
        });
      const skipped = st.queue[0];
      st.player.stop(true);
      return ix.reply({
        embeds: [
          catEmbed({
            title: "ข้ามเพลงให้แล้ว ⏭️",
            description: `**${
              skipped?.title || "Unknown"
            }**\nไปเพลงถัดไปกันเถอะ!`,
            color: 0xffaa00,
          }),
        ],
      });
    }

    // /jump
    if (ix.commandName === "jump") {
      const pos = ix.options.getInteger("pos", true); // 1-based (เพลงถัดจากที่กำลังเล่น)
      if (st.queue.length <= 1)
        return ix.reply({
          content: "คิวสั้นไป ไม่มีเพลงให้กระโดดถึงเลยเมี๊ยว~",
          ephemeral: true,
        });
      if (pos < 1 || pos >= st.queue.length)
        return ix.reply({
          content:
            "หมายเลขไม่ถูกต้องนะ (ดูหมายเลขจาก `/queue` เริ่มที่ 1) เมี๊ยว~",
          ephemeral: true,
        });

      const target = st.queue.splice(pos, 1)[0]; // ตัดเพลงเป้าหมายออก
      st.queue.splice(1, 0, target); // วางเป็นเพลงถัดไป
      st.player.stop(true); // ข้ามเพลงปัจจุบันทันที

      return ix.reply({
        embeds: [
          catEmbed({
            title: "กระโดดไปเพลงที่อยากฟังแล้ว! 🐾",
            description: `เดี๋ยว CozyCat จะไปที่ **${target.title}** ให้เลยเมี๊ยว~`,
            color: 0x00d4ff,
          }),
        ],
      });
    }

    // /remove
    if (ix.commandName === "remove") {
      const pos = ix.options.getInteger("pos", true); // 1-based
      if (st.queue.length <= 1)
        return ix.reply({
          content: "คิวว่างหรือมีแค่เพลงที่กำลังเล่นอยู่ เมี๊ยว~",
          ephemeral: true,
        });
      if (pos < 1 || pos >= st.queue.length)
        return ix.reply({
          content:
            "หมายเลขไม่ถูกต้องนะ (ดูหมายเลขจาก `/queue` เริ่มที่ 1) เมี๊ยว~",
          ephemeral: true,
        });

      const removed = st.queue.splice(pos, 1)[0];
      return ix.reply({
        embeds: [
          catEmbed({
            title: "เอาเพลงออกจากคิวแล้ว 🧹",
            description: `ลบ **${removed.title}** เรียบร้อย เมี๊ยว~`,
            color: 0xff8888,
            footer: `คิวคงเหลือ: ${st.queue.length}`,
          }),
        ],
      });
    }

    // /clear (ลบทุกเพลงในคิว ยกเว้นเพลงที่กำลังเล่น)
    if (ix.commandName === "clear") {
      if (st.queue.length <= 1) {
        return ix.reply({
          content: "คิวว่างอยู่แล้วน้า เมี๊ยว~",
          ephemeral: true,
        });
      }
      const kept = st.queue[0];
      const removedCount = st.queue.length - 1;
      st.queue = [kept];
      return ix.reply({
        embeds: [
          catEmbed({
            title: "ปัดกวาดคิวเรียบร้อย 🧹",
            description: `ลบเพลงในคิวไป **${removedCount}** รายการ เหลือเฉพาะเพลงที่กำลังเล่น เมี๊ยว~`,
            color: 0x66ddff,
          }),
        ],
      });
    }

    // /clearall (ลบคิวทั้งหมด + หยุดเล่น)
    if (ix.commandName === "clearall") {
      st.queue = [];
      st.player.stop(true);
      return ix.reply({
        embeds: [
          catEmbed({
            title: "ล้างคิวหมดเกลี้ยง ⛔",
            description: "หยุดเล่นและลบทุกเพลงออกจากคิวเรียบร้อย เมี๊ยว~",
            color: 0xff3355,
          }),
        ],
      });
    }

    // /pause
    if (ix.commandName === "pause") {
      if (st.player.state.status === AudioPlayerStatus.Playing) {
        st.player.pause();
        return ix.reply("⏸️ เมี๊ยว~ พักก่อนนิดนึง CozyCat จะนอนกอดหมอนแป๊บ 🐾");
      } else {
        return ix.reply({
          content: "ตอนนี้ไม่มีเพลงกำลังเล่นอยู่เลยน้า~",
          ephemeral: true,
        });
      }
    }

    // /resume
    if (ix.commandName === "resume") {
      if (st.player.state.status === AudioPlayerStatus.Paused) {
        st.player.unpause();
        return ix.reply("▶️ ลุยต่อ! CozyCat พร้อมฟังแล้ว 🎶");
      } else {
        return ix.reply({
          content: "ไม่ได้หยุดอยู่ เมี๊ยว~ เล่นอยู่แล้วนะ",
          ephemeral: true,
        });
      }
    }

    // /stop
    if (ix.commandName === "stop") {
      st.queue = [];
      st.player.stop(true);
      return ix.reply({
        embeds: [
          catEmbed({
            title: "หยุดแล้ว และกวาดคิวเรียบร้อย ⏹️",
            description: "ถ้าอยากเริ่มใหม่ บอก CozyCat ได้เสมอเมี๊ยว~",
            color: 0xff3355,
          }),
        ],
      });
    }

    // /queue
    if (ix.commandName === "queue") {
      if (!st.queue.length) {
        return ix.reply({
          embeds: [
            catEmbed({
              title: "คิวเพลงของ CozyCat 📝",
              description: "คิวว่างเปล่า… ส่งเพลงมาให้อุ้มหน่อยสิ~",
              color: 0x999999,
            }),
          ],
        });
      }
      const lines = st.queue
        .map((t, i) =>
          i === 0 ? `**🎵 กำลังเล่น:** ${t.title}` : `**${i}.** ${t.title}`
        )
        .slice(0, 15);
      if (st.queue.length > 15)
        lines.push(`*...และอีก ${st.queue.length - 15} เพลง เมี๊ยว~*`);
      return ix.reply({
        embeds: [
          catEmbed({
            title: "คิวเพลงของ CozyCat 📝",
            description: lines.join("\n"),
            color: 0x00aaff,
            footer: `รวม ${st.queue.length} เพลง • วนซ้ำ: ${
              st.loop ? "เปิด" : "ปิด"
            }`,
          }),
        ],
      });
    }

    // /np
    if (ix.commandName === "np") {
      if (!st.queue[0])
        return ix.reply({
          content: "ยังไม่มีเพลงกำลังเล่น เมี๊ยว~",
          ephemeral: true,
        });
      const current = st.queue[0];
      return ix.reply({
        embeds: [
          catEmbed({
            title: "ตอนนี้กำลังฟังอยู่ 🎶",
            description: `**${current.title}**\n[ลิงก์](${current.url})`,
            thumbnail:
              current.info?.video_details?.thumbnails?.[0]?.url || null,
            color: 0x00ff88,
            footer: `เสียง: ${Math.round(st.volume * 100)}% • วนซ้ำ: ${
              st.loop ? "เปิด" : "ปิด"
            }`,
          }),
        ],
      });
    }

    // /shuffle
    if (ix.commandName === "shuffle") {
      if (st.queue.length <= 2) {
        return ix.reply({
          content: "คิวสั้นไปหน่อย ต้องมีอย่างน้อย 3 เพลงถึงจะเขย่าได้ เมี๊ยว~",
          ephemeral: true,
        });
      }
      const first = st.queue.shift();
      for (let i = st.queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [st.queue[i], st.queue[j]] = [st.queue[j], st.queue[i]];
      }
      st.queue.unshift(first);
      return ix.reply({
        embeds: [
          catEmbed({
            title: "เขย่าคิวเรียบร้อย! 🔀",
            description: "สุ่มลำดับใหม่แล้ว ลองลุ้นกันดูเมี๊ยว~",
            color: 0xaa00ff,
          }),
        ],
      });
    }

    // /loop
    if (ix.commandName === "loop") {
      st.loop = !st.loop;
      return ix.reply({
        embeds: [
          catEmbed({
            title: "โหมดวนซ้ำ 🔁",
            description: `ตอนนี้: **${st.loop ? "เปิด" : "ปิด"}** เมี๊ยว~`,
            color: st.loop ? 0x00ff88 : 0xff3355,
          }),
        ],
      });
    }

    // /vol
    if (ix.commandName === "vol") {
      const p = Math.max(
        1,
        Math.min(200, ix.options.getInteger("percent", true))
      );
      st.volume = p / 100;
      return ix.reply({
        embeds: [
          catEmbed({
            title: "ปรับระดับเสียงแล้ว 🔊",
            description: `ตั้งเป็น **${p}%** เรียบร้อย เมี๊ยว~`,
            color: 0x00aaff,
            footer: "ถ้าเพลงยังไม่เปลี่ยนทันที เดี๋ยวเพลงถัดไปจะดังตามนี้น้า",
          }),
        ],
      });
    }

    // /leave
    if (ix.commandName === "leave") {
      const c = getVoiceConnection(ix.guildId);
      if (c) {
        c.destroy();
        st.queue = [];
        st.player.stop(true);
        return ix.reply({
          embeds: [
            catEmbed({
              title: "โบกหางลาแล้วน้า 👋",
              description:
                "ออกจากห้องเสียงและล้างคิวเรียบร้อย ขอบคุณที่เล่นกับ CozyCat 🐾",
              color: 0xff3355,
            }),
          ],
        });
      } else {
        return ix.reply({
          content: "CozyCat ไม่ได้อยู่ในห้องเสียงอยู่แล้วเมี๊ยว~",
          ephemeral: true,
        });
      }
    }
  } catch (error) {
    console.error("[Command error]", error);
    const errorMessage = {
      embeds: [
        catEmbed({
          title: "โอ๊ะ! CozyCat ขนฟู… มีข้อผิดพลาด 😿",
          description: "มีบางอย่างติดขัด ลองใหม่อีกครั้งได้เลยน้า",
          color: 0xff3355,
        }).addFields({
          name: "รายละเอียด",
          value: `\`${error.message}\``,
          inline: false,
        }),
      ],
    };
    if (ix.deferred) ix.editReply(errorMessage).catch(() => {});
    else ix.reply({ ...errorMessage, ephemeral: true }).catch(() => {});
  }
});

// ---------- Error Handling ----------
client.on("error", console.error);
client.on("warn", console.warn);
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

// ---------- Login ----------
client.login(process.env.DISCORD_TOKEN);
