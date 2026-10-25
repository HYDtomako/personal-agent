#!/usr/bin/env node
/**
 * 把启动器做成"桌面上的一个图标"：生成 .ico、写快捷方式（桌面 + 开始菜单），可选开机自启。
 *
 * 快捷方式指向 node.exe 并以"最小化"运行，所以双击后不会有一个黑窗口留在任务栏上
 * ——launch.ts 起完服务、开完窗口就退出，那个最小化的控制台最多闪一下。
 *
 * 用法：
 *   node app/install.ts              装到桌面 + 开始菜单
 *   node app/install.ts --autostart  顺带开机自启（登录时静默起服务）
 *   node app/install.ts --remove     全部卸掉
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeIco } from "./icon.ts";
import { appName } from "./name.ts";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(appDir, "..");
const argv = process.argv.slice(2);
const wantAutostart = argv.includes("--autostart");
const wantRemove = argv.includes("--remove");

const NAME = appName();

/** 交给 PowerShell 的值一律走单引号字面量（路径里的反斜杠在单引号里是安全的）。 */
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function runPowerShell(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-agent-"));
  const file = path.join(dir, "install.ps1");
  // 带 BOM 写：Windows PowerShell 5.1 没有 BOM 时按 ANSI 读，中文会乱
  writeFileSync(file, "\uFEFF" + script, "utf8");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    { encoding: "utf8", windowsHide: true },
  );
  rmSync(dir, { recursive: true, force: true }); // 临时脚本用完就删，别在 Temp 里堆着
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status !== 0) throw new Error(`PowerShell 失败（code=${r.status}）：\n${out}`);
  return out;
}

/**
 * 路径都在 PowerShell 里算（桌面可能被 OneDrive 重定向，不能拿 %USERPROFILE%\Desktop 硬拼）。
 * 输出统一转 UTF-8，否则中文路径经 Node 解码会乱码。
 */
const PS_HEAD = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell

function New-Lnk {
  param($Path, $Target, $Arguments, $WorkDir, $Icon, $Desc)
  $lnk = $shell.CreateShortcut($Path)
  if (Test-Path $Path) {
    $expectedEntry = ${q(path.join(appDir, "launch.ts"))}
    $legacyEntry = ${q(path.join(root, "tg-bridge.mjs"))}
    if ($lnk.TargetPath -ne $Target -or (-not $lnk.Arguments.StartsWith('"' + $expectedEntry + '"') -and $lnk.Arguments.Trim('"') -ne $legacyEntry)) {
      throw ('快捷方式指向其他程序，拒绝覆盖：' + $Path)
    }
  }
  $lnk.TargetPath = $Target
  $lnk.Arguments = $Arguments
  $lnk.WorkingDirectory = $WorkDir
  if ($Icon -and (Test-Path $Icon)) { $lnk.IconLocation = "$Icon,0" }
  $lnk.Description = $Desc
  $lnk.WindowStyle = 7   # 最小化：别让 node 的控制台占着屏
  $lnk.Save()
  Write-Output ("created " + $Path)
}

$desktop = [Environment]::GetFolderPath("Desktop")
$programs = [Environment]::GetFolderPath("Programs")
$startup = [Environment]::GetFolderPath("Startup")
$lnkDesktop = Join-Path $desktop  ${q(`${NAME}.lnk`)}
$lnkMenu    = Join-Path $programs ${q(`${NAME}.lnk`)}
$lnkStartup = Join-Path $startup  ${q(`${NAME}.lnk`)}
$lnkRestart = Join-Path $desktop ${q(`重启${NAME}.lnk`)}
$legacyTelegram = Join-Path $startup 'guga-tg-bridge.lnk'
`;

function main(): void {
  if (wantRemove) {
    const out = runPowerShell(
      `${PS_HEAD}
foreach ($p in @($lnkDesktop, $lnkMenu, $lnkStartup, $lnkRestart, $legacyTelegram)) {
  if (Test-Path $p) {
    $current = $shell.CreateShortcut($p)
    $entry = ${q(path.join(appDir, "launch.ts"))}
    $legacyEntry = ${q(path.join(root, "tg-bridge.mjs"))}
    if ($current.TargetPath -ne ${q(process.execPath)} -or (-not $current.Arguments.StartsWith('"' + $entry + '"') -and $current.Arguments.Trim('"') -ne $legacyEntry)) {
      throw ('快捷方式指向其他程序，拒绝删除：' + $p)
    }
    Remove-Item $p -Force
    Write-Output ("removed " + $p)
  }
}
`,
    );
    console.log(out || "没有找到已安装的快捷方式。");
    return;
  }

  if (!existsSync(path.join(root, "config.json"))) {
    console.log("提醒：还没有 config.json，装出来的图标双击会弹错误框（先把 config.example.json 复制成 config.json 填好）。");
  }

  // 图标文件随包提供（app/pi-agent.ico，由 app/icon-source.png 生成）；
  // 没有时才用 icon.ts 现画一个，免得重装时把自定义图标覆盖回默认的 π。
  const iconPath = path.join(appDir, "pi-agent.ico");
  const icon = existsSync(iconPath) ? iconPath : writeIco();
  const args = `"${path.join(appDir, "launch.ts")}"`;

  const startupBlock = wantAutostart
    ? `New-Lnk -Path $lnkStartup -Target ${q(process.execPath)} -Arguments ${q(`${args} --no-window`)} -WorkDir ${q(root)} -Icon ${q(icon)} -Desc ${q(NAME)}`
    : `if (Test-Path $lnkStartup) { New-Lnk -Path $lnkStartup -Target ${q(process.execPath)} -Arguments ${q(`${args} --no-window`)} -WorkDir ${q(root)} -Icon ${q(icon)} -Desc ${q(NAME)} }`;
  const legacyBlock = `
if (Test-Path $legacyTelegram) {
  $old = $shell.CreateShortcut($legacyTelegram)
  if ($old.TargetPath -ne ${q(process.execPath)} -or $old.Arguments.Trim('"') -ne ${q(path.join(root, "tg-bridge.mjs"))}) {
    if ($old.TargetPath -ne ${q(process.execPath)} -or $old.Arguments -ne ${q(`${args} --no-window`)}) {
      throw '现有 Telegram 开机快捷方式指向其他目标，拒绝覆盖。'
    }
  }
  New-Lnk -Path $legacyTelegram -Target ${q(process.execPath)} -Arguments ${q(`${args} --no-window`)} -WorkDir ${q(root)} -Icon ${q(icon)} -Desc ${q(`${NAME} + Telegram`)}
}
`;

  const out = runPowerShell(
    `${PS_HEAD}
New-Lnk -Path $lnkDesktop -Target ${q(process.execPath)} -Arguments ${q(args)} -WorkDir ${q(root)} -Icon ${q(icon)} -Desc ${q(NAME)}
New-Lnk -Path $lnkMenu    -Target ${q(process.execPath)} -Arguments ${q(args)} -WorkDir ${q(root)} -Icon ${q(icon)} -Desc ${q(NAME)}
${startupBlock}
${legacyBlock}
`,
  );
  console.log(`图标：${icon}`);
  console.log(out.trim() || "(PowerShell 没有输出)");
  console.log(`node：${process.execPath}`);
  console.log(wantAutostart ? "已装好，并设为开机自启。" : "启动图标已装好，已有开机自启设置保持启用；新增自启用 --autostart，卸掉用 --remove。");
}

main();
