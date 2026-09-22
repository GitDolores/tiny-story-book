// MP3 时长解析与标签剥离（零依赖）
// 供 tts.mjs 计算每页音频时长；不依赖 ffprobe，直接遍历 MPEG 帧头累加

const RATES = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000],  // MPEG2.5
};
const BITRATES = {
  // [versionBits][layerBits] -> kbps 表（0 与 0xF 为保留值）
  3: { 3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0], 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0] },
  2: { 3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0], 1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0] },
};
BITRATES[0] = BITRATES[2]; // MPEG2.5 与 MPEG2 共用码率表

function id3v2Size(buf) {
  // 'ID3' + 版本2 + 标志1 + 同步安全长度4
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return -1;
  let size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  if (buf[5] & 0x10) size += 10; // 带 footer 的 ID3v2.4
  return size;
}

// 遍历 MPEG 帧头累加时长（秒）；跳过 ID3v2/ID3v1 与杂散字节，容错乱码
export function mp3Duration(buf) {
  const id3 = id3v2Size(buf);
  let pos = id3 >= 0 ? 10 + id3 : 0;
  let seconds = 0;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) { pos++; continue; }
    const versionBits = (buf[pos + 1] >> 3) & 0x03; // 11=MPEG1, 10=MPEG2, 00=MPEG2.5
    const layerBits = (buf[pos + 1] >> 1) & 0x03;   // 11=LayerI, 10=LayerII, 01=LayerIII
    if (versionBits === 0x01 || layerBits === 0x00) { pos++; continue; }
    const bitrateIdx = (buf[pos + 2] >> 4) & 0x0f;
    const rateIdx = (buf[pos + 2] >> 2) & 0x03;
    const padding = (buf[pos + 2] >> 1) & 0x01;
    const sampleRate = RATES[versionBits][rateIdx];
    const bitrate = BITRATES[versionBits][layerBits][bitrateIdx] * 1000;
    if (!sampleRate || !bitrate) { pos++; continue; }
    const mpeg1 = versionBits === 0x03;
    const samplesPerFrame = layerBits === 0x03 ? 384 : layerBits === 0x02 ? 1152 : (mpeg1 ? 1152 : 576);
    const frameLen = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
    if (frameLen <= 4) { pos++; continue; }
    seconds += samplesPerFrame / sampleRate;
    pos += frameLen;
  }
  return seconds;
}

// 去掉 ID3v2（头部）与 ID3v1（尾部 'TAG'），让多段 mp3 可直接字节级拼接
export function stripTags(buf) {
  const id3 = id3v2Size(buf);
  const start = id3 >= 0 ? Math.min(10 + id3, buf.length) : 0;
  let end = buf.length;
  if (end - start >= 128 && buf[end - 128] === 0x54 && buf[end - 127] === 0x41 && buf[end - 126] === 0x47) {
    end -= 128;
  }
  return buf.subarray(start, end);
}

// 解析一个有效帧头；返回 null 表示不是可解析的 MPEG 帧
function frameInfo(buf, pos) {
  if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buf[pos + 1] >> 3) & 0x03;
  const layerBits = (buf[pos + 1] >> 1) & 0x03;
  if (versionBits === 0x01 || layerBits === 0x00) return null;
  const bitrateIdx = (buf[pos + 2] >> 4) & 0x0f;
  const rateIdx = (buf[pos + 2] >> 2) & 0x03;
  const padding = (buf[pos + 2] >> 1) & 0x01;
  const sampleRate = RATES[versionBits][rateIdx];
  const bitrate = BITRATES[versionBits][layerBits][bitrateIdx] * 1000;
  if (!sampleRate || !bitrate) return null;
  const mpeg1 = versionBits === 0x03;
  const samplesPerFrame = layerBits === 0x03 ? 384 : layerBits === 0x02 ? 1152 : (mpeg1 ? 1152 : 576);
  const frameLen = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
  if (frameLen <= 4) return null;
  return { sampleRate, samplesPerFrame, frameLen, headerAt: pos };
}

// 生成与 template 同格式的静音 mp3：帧头原样复制（保留声道/码率/采样率位），
// 载荷与边信息全零 = 数字静音。用于把每页音频补齐到固定秒数；
// 无法解析模板帧头时返回空 Buffer，调用方回退为实际时长
export function mp3Silence(seconds, template) {
  if (!(seconds > 0) || !template || template.length < 4) return Buffer.alloc(0);
  const id3 = id3v2Size(template);
  let pos = id3 >= 0 ? Math.min(10 + id3, template.length) : 0;
  let info = null;
  while (pos + 4 <= template.length && !info) {
    info = frameInfo(template, pos);
    if (!info) pos++;
  }
  if (!info) return Buffer.alloc(0);
  const count = Math.max(0, Math.round((seconds * info.sampleRate) / info.samplesPerFrame));
  const frame = Buffer.alloc(info.frameLen, 0);
  template.copy(frame, 0, info.headerAt, info.headerAt + 4);
  return Buffer.concat(Array.from({ length: count }, () => frame));
}
