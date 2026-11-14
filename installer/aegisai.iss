; AegisAI Inno Setup installer
; Build: iscc installer\aegisai.iss
; Requires: Inno Setup 6 (https://jrsoftware.org/isinfo.php)

#define MyAppName "AegisAI"
#define MyAppVersion "2.2.7"
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
Name: "models"; Description: "Download recommended AI models (~27 GB)"; Types: full
Name: "models\llama32_3b"; Description: "llama3.2:3b (~2.0 GB)"; Types: full
Name: "models\llama32_1b"; Description: "llama3.2:1b (~1.3 GB)"; Types: full
Name: "models\qwen25_14b"; Description: "qwen2.5:14b (~9.0 GB)"; Types: full
Name: "models\qwen25coder_14b"; Description: "qwen2.5-coder:14b (~9.0 GB)"; Types: full
Name: "models\mistral_7b"; Description: "mistral:7b (~4.1 GB)"; Types: full
Name: "models\nomic_embed"; Description: "nomic-embed-text (~0.3 GB)"; Types: full
Name: "models\moondream"; Description: "moondream (~1.7 GB)"; Types: full

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
; Bundled Node.js (only included when present at build time)
#if FileExists(SourcePath + "node-runtime/node.exe")
Source: "node-runtime\*"; DestDir: "{app}\runtime\node"; Flags: ignoreversion recursesubdirs; Components: node; Check: NodeRuntimeExists
#endif
; Bundled Ollama (only included when present at build time)
#if FileExists(SourcePath + "ollama-runtime/ollama.exe")
Source: "ollama-runtime\*"; DestDir: "{app}\runtime\ollama"; Flags: ignoreversion recursesubdirs;
#endif

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
Filename: "cmd.exe"; Parameters: "/c cd /d ""{app}"" && ""{app}\runtime\node\node.exe"" ""{app}\runtime\node\node_modules\npm\bin\npm-cli.js"" install"; StatusMsg: "Installing npm dependencies (bundled Node)..."; Flags: runhidden waituntilterminated; Check: IsBundledNode
; Start Ollama if bundled
Filename: "{app}\runtime\ollama\ollama.exe"; Parameters: "serve"; StatusMsg: "Starting Ollama..."; Flags: nowait; Check: OllamaRuntimeExists
; Launch app
Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""AegisAI"""; Flags: runhidden; RunOnceId: "RemoveFirewall"

[Run]
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=AegisAI dir=in action=allow protocol=tcp localport=8080"; Flags: runhidden; Check: WizardIsTaskSelected('firewall')

[Code]
var
  BackendPage: TInputOptionWizardPage;
  BackendType: String;
  BackendUrl: String;

procedure InitializeWizard;
begin
  BackendPage := CreateInputOptionPage(wpSelectComponents,
    'AI Backend', 'Choose the AI backend AegisAI will use.',
    'Select the backend. Ollama is recommended for most users; other backends must be started separately.',
    True, False);
  BackendPage.Add('Ollama (default, recommended)');
  BackendPage.Add('llama.cpp');
  BackendPage.Add('LM Studio');
  BackendPage.Add('OpenAI-compatible');
  BackendPage.SelectedValueIndex := 0;
end;

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

function GenerateToken: String;
begin
  Result := GetSHA256OfString(GetDateTimeString('yyyymmddhhnnss', #0, #0) + GetComputerNameString + GetUserNameString);
end;

function OllamaAvailable: Boolean;
var
  Rc: Integer;
begin
  Result := Exec('cmd.exe', '/c where ollama >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, Rc) and (Rc = 0);
end;

procedure EnsureOllamaRunning;
var
  Rc, I: Integer;
begin
  for I := 1 to 10 do
  begin
    if Exec('cmd.exe', '/c curl -s http://127.0.0.1:11434/api/version >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, Rc) and (Rc = 0) then
      Exit;
    if I = 1 then
      Exec('ollama', 'serve', '', SW_HIDE, ewNoWait, Rc);
    Sleep(1000);
  end;
end;

procedure PullSelectedModels;
var
  CompNames: array of String;
  ModelNames: array of String;
  I: Integer;
  Rc: Integer;
begin
  SetArrayLength(CompNames, 7);
  SetArrayLength(ModelNames, 7);
  CompNames[0] := 'models\llama32_3b';       ModelNames[0] := 'llama3.2:3b';
  CompNames[1] := 'models\llama32_1b';       ModelNames[1] := 'llama3.2:1b';
  CompNames[2] := 'models\qwen25_14b';       ModelNames[2] := 'qwen2.5:14b';
  CompNames[3] := 'models\qwen25coder_14b';  ModelNames[3] := 'qwen2.5-coder:14b';
  CompNames[4] := 'models\mistral_7b';       ModelNames[4] := 'mistral:7b';
  CompNames[5] := 'models\nomic_embed';      ModelNames[5] := 'nomic-embed-text';
  CompNames[6] := 'models\moondream';        ModelNames[6] := 'moondream';
  if OllamaAvailable then
    EnsureOllamaRunning;
  for I := 0 to 6 do
  begin
    if WizardIsComponentSelected(CompNames[I]) then
    begin
      if OllamaAvailable then
      begin
        if Exec('ollama', 'pull ' + ModelNames[I], '', SW_HIDE, ewWaitUntilTerminated, Rc) and (Rc = 0) then
          Log('Pulled model ' + ModelNames[I])
        else
          Log('Failed to pull model ' + ModelNames[I] + ' (rc=' + IntToStr(Rc) + ')');
      end
      else
        Log('Ollama not found; skipping model ' + ModelNames[I]);
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  backendFile: String;
  bt, bu: String;
  LanToken: String;
begin
  if CurStep = ssPostInstall then
  begin
    case BackendPage.SelectedValueIndex of
      1: begin bt := 'llamacpp'; bu := 'http://127.0.0.1:8081'; end;
      2: begin bt := 'lmstudio'; bu := 'http://127.0.0.1:1234'; end;
      3: begin bt := 'openai'; bu := 'http://127.0.0.1:8000'; end;
    else begin bt := 'ollama'; bu := 'http://127.0.0.1:11434'; end;
    end;
    BackendType := bt;
    BackendUrl := bu;
    backendFile := ExpandConstant('{app}\backend.txt');
    SaveStringToFile(backendFile, 'BACKEND_TYPE=' + bt + #13#10 + 'BACKEND_URL=' + bu + #13#10, False);

    // LAN access: the launcher binds 0.0.0.0 only when lan-access.txt exists,
    // and the server refuses a non-loopback bind without an auth token.
    if WizardIsTaskSelected('firewall') then
    begin
      LanToken := GenerateToken;
      SaveStringToFile(ExpandConstant('{app}\lan-access.txt'), 'LAN access enabled by installer.' + #13#10, False);
      SaveStringToFile(ExpandConstant('{app}\auth.json'), '{ "token": "' + LanToken + '" }' + #13#10, False);
      Log('LAN auth token: ' + LanToken);
      MsgBox('LAN access enabled.' + #13#10 + #13#10 +
             'Auth token (enter it in the web UI):' + #13#10 + LanToken,
             mbInformation, MB_OK);
    end;

    PullSelectedModels;
  end;
end;

[CustomMessages]
LaunchProgram=Launch {#MyAppName}
AdditionalIcons=Additional icons:
CreateDesktopIcon=Create a &desktop icon
