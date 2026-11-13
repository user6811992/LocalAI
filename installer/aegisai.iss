; AegisAI Inno Setup installer
; Build: iscc installer\aegisai.iss
; Requires: Inno Setup 6 (https://jrsoftware.org/isinfo.php)

#define MyAppName "AegisAI"
#define MyAppVersion "2.1.92"
#define MyAppPublisher "AegisAI"
#define MyAppURL "https://github.com/user6811992/LocalAI"
#define MyAppExeName "launcher.vbs"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
LicenseFile=..\LICENSE
OutputDir=..\installer\output
OutputBaseFilename=AegisAI-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\public\icon.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "full"; Description: "Full installation (app + recommended models)"
Name: "minimal"; Description: "Minimal installation (app only, no models)"
Name: "custom"; Description: "Custom installation"; Flags: iscustom

[Components]
Name: "app"; Description: "AegisAI application"; Types: full minimal custom; Flags: fixed
Name: "node"; Description: "Bundled Node.js runtime (recommended)"; Types: full minimal custom
Name: "models"; Description: "Download recommended AI models (~38 GB)"; Types: full
Name: "models\llama32_3b"; Description: "llama3.2:3b (~2.0 GB)"; Types: full
Name: "models\llama32_1b"; Description: "llama3.2:1b (~1.3 GB)"; Types: full
Name: "models\qwen25_14b"; Description: "qwen2.5:14b (~9.0 GB)"; Types: full
Name: "models\qwen25coder_14b"; Description: "qwen2.5-coder:14b (~9.0 GB)"; Types: full
Name: "models\mistral_7b"; Description: "mistral:7b (~4.1 GB)"; Types: full
Name: "models\nomic_embed"; Description: "nomic-embed-text (~0.3 GB)"; Types: full
Name: "models\moondream"; Description: "moondream (~1.7 GB)"; Types: full
Name: "rea"; Description: "Clone REA source repo (reverse engineering)"; Types: full

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startupicon"; Description: "Start AegisAI automatically at login"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "firewall"; Description: "Allow LAN access (firewall rule for port 8080)"; GroupDescription: "Network:"; Flags: unchecked

[Files]
; Application files
Source: "..\server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package-lock.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\mcp-config.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\SECURITY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs
Source: "..\tests\*"; DestDir: "{app}\tests"; Flags: ignoreversion recursesubdirs
Source: "..\lib\*"; DestDir: "{app}\lib"; Flags: ignoreversion recursesubdirs
; Installers (kept for compatibility)
Source: "..\install.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\install.sh"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\install.hta"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\launcher.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\uninstall.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\uninstall.sh"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tray.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tray.ps1"; DestDir: "{app}"; Flags: ignoreversion
; Bundled Node.js (if present in installer\node-runtime)
Source: "node-runtime\*"; DestDir: "{app}\runtime\node"; Flags: ignoreversion recursesubdirs; Components: node; Check: NodeRuntimeExists
; Bundled Ollama (if present)

[Dirs]
Name: "{app}\workspace"; Flags: uninsneveruninstall
Name: "{app}\data"; Flags: uninsneveruninstall

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\public\icon.ico"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\public\icon.ico"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\public\icon.ico"; Tasks: startupicon

[Run]
; Run npm install
Filename: "cmd.exe"; Parameters: "/c cd /d ""{app}"" && npm install"; StatusMsg: "Installing npm dependencies..."; Flags: runhidden waituntilterminated; Check: not IsBundledNode
Filename: "cmd.exe"; Parameters: "/c cd /d ""{app}"" && ""{app}\runtime\node\node.exe"" ""{app}\runtime\node\npm\bin\npm-cli.js"" install"; StatusMsg: "Installing npm dependencies (bundled Node)..."; Flags: runhidden waituntilterminated; Check: IsBundledNode
; Start Ollama if bundled
Filename: "{app}\runtime\ollama\ollama.exe"; Parameters: "serve"; StatusMsg: "Starting Ollama..."; Flags: nowait; Check: OllamaRuntimeExists
; Launch app
Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""AegisAI"""; Flags: runhidden; RunOnceId: "RemoveFirewall"

[Run]
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=AegisAI dir=in action=allow protocol=tcp localport=8080"; Flags: runhidden; Check: IsTaskSelected('firewall')

[Code]
function NodeRuntimeExists: Boolean;
begin
  Result := DirExists(ExpandConstant('{app}\runtime\node'));
end;

function OllamaRuntimeExists: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\runtime\ollama\ollama.exe'));
end;

function IsBundledNode: Boolean;
begin
  Result := NodeRuntimeExists;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    // Write pull-models.bat based on selected components
    // (simplified: pull all recommended models if 'models' component selected)
  end;
end;

[CustomMessages]
LaunchProgram=Launch {#MyAppName}
AdditionalIcons=Additional icons:
CreateDesktopIcon=Create a &desktop icon
