// 验收环境的建立与清理（临时库、临时 Chrome profile、注册项、进程）。
//
// 硬规则：
//   * 只用临时目录；KEYNEST_DATA_DIR 同时隔离 vault.dat / vault.lock / bridge.key
//   * 注册表只碰 HKCU 下 com.keynest.bridge 一条，退出时必删
//   * 不读、不写、不猜真实库与真实 bridge.key

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const REPO = path.resolve(import.meta.dirname, '../../..');
export const HOST_EXE = path.join(REPO, 'rust/target/debug/keynest-native-host.exe');
export const GUI_EXE = path.join(REPO, 'rust/target/debug/keynest-egui.exe');
export const EXT_DIR = path.join(REPO, 'browser-extension');
export const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const PS = 'powershell.exe';

const NL = String.fromCharCode(10);

export function makeRoots(tag = 'kn274') {
  const root = path.join(os.tmpdir(), tag);
  return {
    root,
    data: path.join(root, 'data'),
    profile: path.join(root, 'profile'),
    manifest: path.join(root, 'manifest'),
    site: path.join(root, 'site'),
    logs: path.join(root, 'logs'),
  };
}

/** 先杀进程再删目录：上一轮异常退出时 Chrome 还握着 profile 里的句柄。 */
export function resetRoots(dirs) {
  killAll();
  for (let i = 0; i < 8; i += 1) {
    try {
      fs.rmSync(dirs.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      break;
    } catch (e) {
      if (i === 7) throw e;
      spawnSync(PS, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 700']);
    }
  }
  for (const d of [dirs.data, dirs.profile, dirs.manifest, dirs.site, dirs.logs]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/**
 * 生成临时库（虚构账号、虚构主密码、条目网址对准测试站点）。
 *
 * 用 seed_site 而不是 write：后者的条目网址写死 https://rust.test，
 * 对不上验收站点，query 会返回 0 条，测试就白跑了。
 */
export function seedVault(dirs, master, siteUrl) {
  const vaultPath = path.join(dirs.data, 'vault.dat');
  const out = spawnSync(
    'C:/Users/XIM/.cargo/bin/cargo.exe',
    ['run', '-q', '-p', 'keynest-core', '--example', 'seed_site', '--', vaultPath, master, siteUrl],
    { cwd: path.join(REPO, 'rust'), encoding: 'utf8' }
  );
  if (out.status !== 0) {
    throw new Error(`seed vault failed: ${out.status}${NL}${out.stdout}${NL}${out.stderr}`);
  }
  return vaultPath;
}

/** 注册 Native Host（只写 HKCU 本条 + 指向临时 manifest 目录）。 */
export function registerHost({ manifestDir, chromeId, hostExe = HOST_EXE }) {
  const ps = path.join(REPO, 'scripts/register-native-host-dev.ps1');
  execFileSync(
    PS,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ps,
      '-HostExe',
      hostExe,
      '-ChromeId',
      chromeId,
      '-ManifestDir',
      manifestDir,
    ],
    { encoding: 'utf8', stdio: 'pipe' }
  );
}

export function unregisterHost({ manifestDir, hostExe = HOST_EXE }) {
  const ps = path.join(REPO, 'scripts/register-native-host-dev.ps1');
  try {
    execFileSync(
      PS,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ps,
        '-Uninstall',
        '-HostExe',
        hostExe,
        '-ManifestDir',
        manifestDir,
      ],
      { encoding: 'utf8', stdio: 'pipe' }
    );
  } catch (e) {
    process.stderr.write(`[cleanup] unregister failed: ${e.message}${NL}`);
  }
}

export function registryState() {
  const q = (root) => {
    const r = spawnSync(
      PS,
      ['-NoProfile', '-Command', `Test-Path 'HKCU:\\${root}\\com.keynest.bridge'`],
      { encoding: 'utf8' }
    );
    return String(r.stdout).trim() === 'True';
  };
  return {
    chrome: q('Software\\Google\\Chrome\\NativeMessagingHosts'),
    edge: q('Software\\Microsoft\\Edge\\NativeMessagingHosts'),
  };
}

/**
 * 启动 GUI（KEYNEST_DATA_DIR 指向临时目录），独立存活。
 *
 * 不能用 execFileSync：Start-Process 让 GUI 继承了 PowerShell 的标准句柄，
 * execFileSync 等的是句柄 EOF，而 GUI 不退出就永远等不到。
 */
export function startGui(dirs) {
  const out = fs.openSync(path.join(dirs.logs, 'gui.out'), 'a');
  const err = fs.openSync(path.join(dirs.logs, 'gui.err'), 'a');
  // detached + unref：GUI 必须活过本脚本。stdio 直接绑文件句柄，
  // 不走管道——管道会在父进程退出时关掉，GUI 随之拿到 EOF/EPIPE。
  //
  // 为什么不用 PowerShell 的 Start-Process -RedirectStandardOutput：
  // 本机环境里同时存在 NO_PROXY 与 no_proxy 两个变量，PowerShell 5.1 会把它们
  // 塞进同一个大小写不敏感的字典而抛「关键字重复」，启动直接失败。
  const env = { ...process.env, KEYNEST_DATA_DIR: dirs.data };
  // 顺手去掉重复的大小写代理变量，避免子进程里其它工具也踩同一个坑
  delete env.NO_PROXY;
  const child = spawn(GUI_EXE, [], {
    env,
    stdio: ['ignore', out, err],
    detached: true,
    windowsHide: false,
  });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
}

export function guiLog(dirs) {
  const parts = [];
  for (const name of ['gui.out', 'gui.err']) {
    const file = path.join(dirs.logs, name);
    if (fs.existsSync(file)) {
      parts.push(`--- ${name} ---${NL}${fs.readFileSync(file, 'utf8')}`);
    }
  }
  return parts.join(NL);
}

export function killAll() {
  for (const name of ['chrome', 'keynest-egui', 'keynest-native-host']) {
    spawnSync(PS, [
      '-NoProfile',
      '-Command',
      `Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`,
    ]);
  }
}

export async function waitFile(p, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(p)) return true;
    await sleep(120);
  }
  return false;
}

/** 生成自签证书（SAN 同时含 DNS:localhost 与 IP:127.0.0.1）。已存在则复用。 */
export function ensureCert(dirs) {
  const cert = path.join(dirs.site, 'cert.pem');
  const key = path.join(dirs.site, 'key.pem');
  if (fs.existsSync(cert) && fs.existsSync(key)) return dirs.site;
  execFileSync(
    'bash',
    [
      '-lc',
      `cd "${dirs.site}" && MSYS2_ARG_CONV_EXCL='*' openssl req -x509 -newkey rsa:2048 -nodes ` +
        `-keyout key.pem -out cert.pem -days 2 -subj "/CN=KeyNest Test" ` +
        `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
    ],
    { stdio: 'pipe' }
  );
  return dirs.site;
}

/** 用真实输入事件解锁 GUI。是否真的解锁由调用方看 bridge.key 是否出现。 */
export function unlockGui(dirs, master) {
  const ps = path.join(REPO, 'test/acceptance/gui-unlock.ps1');
  const r = spawnSync(
    PS,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Master', master],
    { encoding: 'utf8' }
  );
  return { status: r.status, out: String(`${r.stdout || ''}${r.stderr || ''}`).trim() };
}
