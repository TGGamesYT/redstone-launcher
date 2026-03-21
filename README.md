# Redstone Launcher

This is the source code of the unofficial Minecraft launcher, **Redstone Launcher**.

Redstone Launcher is an Electron-based application, meaning it runs on Node.js.

## Running Locally

To run the app, clone the repository, install its dependencies, and run the app command:

```bash
git clone https://github.com/tggamesyt/redstone-launcher.git
cd redstone-launcher
npm install
npm run app
```

## Building the App

To build the application for your operating system, make sure you have cloned the repo and installed the dependencies (`npm install`), then run the appropriate build command:

### Windows
```bash
npm run buildWin
```

### Linux
```bash
npm run buildLinux
```

### macOS
```bash
npm run buildMac
```

### Building Linux from Windows

To build the Linux version from Windows using Docker, run the following command in PowerShell:

```powershell
docker run --rm -ti -v "${PWD}:/project" -v "${PWD}/dist:/project/dist" electronuserland/builder:latest /bin/bash -c "npm install && npm run buildLinux"
```
  <br>
  <hr>
  <br>
  
# Redstone Launcher - Linux Installation Guide (.deb)

Follow these instructions to install and run the launcher on Debian-based systems (Ubuntu, Debian, Kali) **without errors**.

## 1. Installation
Open your terminal in the folder where your .deb file is located and run:
```bash
sudo dpkg -i redstone-launcher.deb
sudo apt install -f
```
### 2. Fixing the "Sharp / libvips" Error

*If the app fails to start with a "JavaScript error" related to the "sharp" module or "libvips", run these commands to link your system libraries:
Bash*

## Install the required library

```bash
sudo apt update && sudo apt install libvips42 -y
```
## Create a symlink to match the version expected by the launcher

```bash
sudo ln -s /usr/lib/x86_64-linux-gnu/libvips-cpp.so.42 /usr/lib/x86_64-linux-gnu/libvips-cpp.so.8.17.3
```

### 3. How to Launch (Fixing Sandbox issues)

On Kali Linux, the launcher must be started with the --no-sandbox flag to work correctly:
Bash

```bash
redstone-launcher --no-sandbox
```

### 4. Troubleshooting Login (Token Undefined)

If you can't log in to your Microsoft account:
    Install the gnome-keyring: 
    ```bash
    sudo apt install gnome-keyring
    ```

Open the launcher, go to Settings, log out completely, and log back in.
