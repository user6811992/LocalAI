# Local AI system tray icon
$ErrorActionPreference = 'SilentlyContinue'
$base = $PSScriptRoot
if (-not $base) { $base = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $base) { $base = "C:\Users\$env:USERNAME\Documents\LocalAI" }

Add-Type -AssemblyName System.Windows.Forms
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = "Local AI"
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open Local AI")
$openItem.Add_Click({ Start-Process "msedge" -ArgumentList "--app=http://127.0.0.1:8080","--window-size=1200,800" })
$exitItem = $menu.Items.Add("Exit")
$exitItem.Add_Click({ $icon.Visible = $false; $icon.Dispose(); exit })
$icon.ContextMenuStrip = $menu

# Auto-start at login: place a shortcut in Startup folder
# (handled by install.ps1)

while ($true) { Start-Sleep -Seconds 5 }