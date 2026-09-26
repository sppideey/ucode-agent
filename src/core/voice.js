/**
 * voice.js — the mic button: say what you want instead of typing it.
 *
 * Recording uses what the computer already has, so there is nothing to
 * install on Windows: its own sound recorder API (winmm, driven through
 * PowerShell). macOS uses sox or ffmpeg, Linux arecord or sox, whichever is
 * there. The recording is sent to the same Gemini model as everything else,
 * which writes down what was said (see transcribe in provider.js).
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Longest a recording runs before it stops by itself. */
export const MAX_RECORD_MS = 2 * 60_000;

/**
 * Loudest sample (of 32767) below which a recording counts as silence. A quiet
 * room measured ~400 on a laptop mic, speech ~3,000 and up. UCODE_MIC_QUIET
 * tunes it for a mic that reads differently.
 */
export const quietBelow = () => Number(process.env.UCODE_MIC_QUIET) || 800;

// winmm's MCI strings refuse long paths (error 304), so the file sits directly
// in the temp folder with a short name. The script says "ready" once it is
// recording, and saves when a line arrives on stdin.
const WINDOWS_SCRIPT = [
  '$sig = \'[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string c, System.Text.StringBuilder r, int l, System.IntPtr h);\'',
  '$w = Add-Type -MemberDefinition $sig -Name Mci -Namespace UcodeMic -PassThru',
  'function mci($c) { $r = $w::mciSendString($c, $null, 0, [IntPtr]::Zero); if ($r -ne 0) { [Console]::Out.WriteLine("mci-error $r"); exit 1 } }',
  'mci "open new type waveaudio alias ucodemic"',
  'mci "set ucodemic bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2"',
  'mci "record ucodemic"',
  '[Console]::Out.WriteLine("ready")',
  '[void][Console]::In.ReadLine()',
  'mci "stop ucodemic"',
  'mci (\'save ucodemic "\' + $env:UCODE_MIC_FILE + \'"\')',
  'mci "close ucodemic"',
].join('\n');

/**
 * The recorders to try on this platform, in order. `stop` is how each is told
 * to finish and write its file: a line on stdin, "q" on stdin, or SIGINT.
 */
export function recordersFor(platform, file) {
  if (platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
    return [{
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      stop: 'line',
      saysReady: true,
    }];
  }
  const sox = { cmd: 'rec', args: ['-q', '-c', '1', '-r', '16000', '-b', '16', file], stop: 'SIGINT' };
  if (platform === 'darwin') {
    return [sox, {
      cmd: 'ffmpeg',
      args: ['-loglevel', 'error', '-f', 'avfoundation', '-i', ':0', '-ac', '1', '-ar', '16000', '-y', file],
      stop: 'q',
    }];
  }
  return [{ cmd: 'arecord', args: ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', file], stop: 'SIGINT' }, sox];
}

const NO_RECORDER = {
  darwin: 'No recorder found. Install one with: brew install sox',
  linux: 'No recorder found. Install one with: sudo apt install alsa-utils',
};

/** Start one recorder; resolves once it is listening, rejects with the reason it could not. */
function launch(rec, file, run) {
  return new Promise((resolve, reject) => {
    const child = run(rec.cmd, rec.args, {
      env: { ...process.env, UCODE_MIC_FILE: file },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };

    child.on('error', (err) => done(reject, err));
    child.stdout?.on('data', (d) => {
      out += d;
      if (rec.saysReady && out.includes('ready')) done(resolve, child);
      const code = /mci-error (\d+)/.exec(out)?.[1];
      if (code) done(reject, new Error(`Windows could not use the microphone (error ${code}). Check one is plugged in and allowed in Settings › Privacy › Microphone.`));
    });
    child.on('exit', (code) => done(reject, new Error(`The recorder stopped before listening (exit ${code}). Check a microphone is connected.`)));
    if (!rec.saysReady) child.on('spawn', () => done(resolve, child));
  });
}

/**
 * Start recording from the default microphone.
 * Resolves to { stop() → Promise<Buffer|null>, cancel() → Promise<void> } once listening.
 */
export async function startRecording({ platform = process.platform, run = spawn, dir = os.tmpdir() } = {}) {
  // A private folder of its own, so no other user can guess or pre-place the file.
  const folder = await fs.mkdtemp(path.join(dir, 'ucm-'));
  const file = path.join(folder, 'mic.wav');
  const remove = () => fs.rm(folder, { recursive: true, force: true }).catch(() => {});

  let child = null;
  let rec = null;
  try {
    for (const candidate of recordersFor(platform, file)) {
      try {
        child = await launch(candidate, file, run);
        rec = candidate;
        break;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  } catch (err) {
    await remove();
    throw err;
  }
  if (!child) {
    await remove();
    throw new Error(NO_RECORDER[platform] ?? 'No sound recorder found on this computer.');
  }

  const closed = new Promise((resolve) => child.on('close', resolve));
  // A recorder that will not finish is killed rather than waited on forever.
  const finished = async () => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await closed;
    clearTimeout(timer);
  };

  return {
    async stop() {
      if (rec.stop === 'line') child.stdin.write('\n');
      else if (rec.stop === 'q') child.stdin.write('q');
      else child.kill('SIGINT');
      await finished();
      const wav = await fs.readFile(file).catch(() => null);
      await remove();
      return wav;
    },
    async cancel() {
      child.kill();
      await finished();
      await remove();
    },
  };
}

/** True when a 16-bit PCM WAV holds nothing louder than room noise, or under a third of a second. */
export function isSilent(wav, threshold = quietBelow()) {
  const at = wav.indexOf('data');
  const start = at >= 0 ? at + 8 : 44;
  if (wav.length - start < 16000 * 2 / 3) return true;
  for (let i = start; i + 1 < wav.length; i += 2) {
    if (Math.abs(wav.readInt16LE(i)) >= threshold) return false;
  }
  return true;
}

/** What the model heard, as one line for the input box: no quotes, no line breaks. */
export function cleanTranscript(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
}
