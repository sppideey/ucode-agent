<div align="center">

# ucode

**A free, open-source AI coding agent for your terminal.**<br>
Builds whole apps in about a minute on Google Gemini's free tier — then opens them and clicks through to check its own work.

[![npm](https://img.shields.io/npm/v/ucode-agent?color=4d8dff&label=npm)](https://www.npmjs.com/package/ucode-agent)
[![downloads](https://img.shields.io/npm/dm/ucode-agent?color=4d8dff)](https://www.npmjs.com/package/ucode-agent)
[![tests](https://github.com/sppideey/ucode-agent/actions/workflows/test.yml/badge.svg)](https://github.com/sppideey/ucode-agent/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-AGPL--3.0-4d8dff)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-4d8dff)](https://nodejs.org)
[![stars](https://img.shields.io/github/stars/sppideey/ucode-agent?style=social)](https://github.com/sppideey/ucode-agent/stargazers)

<img src="https://raw.githubusercontent.com/sppideey/ucode-agent/main/.github/ucode-hero.png" alt="ucode in a terminal: a tasks app built in 58 seconds, with the command list popped up over the input box" width="900">

</div>

```bash
npm i -g ucode-agent     # Node 22 or newer
ucode login YOUR_KEY     # a free key from aistudio.google.com/apikey
ucode                    # in any project folder
```

A coding agent that lives in your terminal, like Claude Code or Codex CLI — but
free: it runs on Gemini's free tier, or on Ollama with no internet at all. It
reads your code, edits it, runs your commands, checks its own work, and keeps
every conversation on disk. If it helps you, a ⭐ helps other people find it.
