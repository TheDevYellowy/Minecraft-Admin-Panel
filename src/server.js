
// Const
const childProcess = require('child_process');
const readline = require('node:readline');
const path = require('path');
const http = require('http');
const packageJson = require('../package.json');
const assert = require('node:assert');
const express = require('express');
const sse = require('connect-sse')(),
      cors = require('connect-xcors')(),
      noCache = require('connect-nocache')();
const EventEmitter = require('node:events').EventEmitter;
const fs = require('node:fs');

// var / define later
var settings;
var eventHistoryCount = 100;

// define settings
if(fs.existsSync(path.join(process.cwd(), 'settings', 'settings.json'))) settings = require(path.join(process.cwd(), 'settings', 'settings.json'));
else {
    fs.rename(path.join(process.cwd(), 'settings', 'base.settings.json'), path.join(process.cwd(), 'settings', 'settings.json'), (err) => {
        if(err) throw err;
        else settings = require(path.join(process.cwd(), 'settings', 'settings.json'));
    })
}

// define other variables
var onliner = {};
var eventHistory = [];
var lastSeen = {};
var bus = new EventEmitter().setMaxListeners(0);
var mcServer = null;
var httpServer = null;
var killTimeout = null;

var lineHandlers = [];

main();

function emitEvent(type, value) {
    var event = {
        type: type,
        date: new Date(),
        value: value
    };
    if(type !== 'userActivity') {
        eventHistory.push(event);
        while(eventHistory.length > eventHistoryCount) {
            eventHistory.shift();
        }
    }
    bus.emit('event', event);
}

function startServer() {
    var app = express();
    app.use(noCache);
    app.use(express.static(path.join(__dirname, 'public')));
    app.get('/events', [sse, cors], httpGetEvents);
    httpServer = http.createServer(app);
    httpServer.listen(settings.WebPort, function() {
        console.info(`Listening at http://localhost:${settings.WebPort}`);
    });
}

function httpGetEvents(req, res) {
    res.setMaxListeners(0);
    function busOn(event, cb) {
        bus.on(event, cb);
        res.on('close', function() {
            bus.removeListener(event, cb);
        });
    }
    res.json({
        type: 'history',
        value: {
            onliner,
            lastSeen,
            eventHistory,
            version: packageJson.version,
        }
    });
    busOn('event', function(event) {
        res.json({
            type: 'event',
            value: event
        });
    });
}

function startReadingInput() {
    var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.on('line', (line) => {
        if(line) mcPut(line)
        rl.prompt();
    });
    rl.on('close', onClose);
    process.once('SIGINT', onClose);
    rl.prompt();

    function onClose() {
        mcServer.removeListener('exit', restartMcServer);
        httpServer.close();
        rl.close();
        // if minecraft takes longer than 5 seconds to stop, kill it
        killTimeout = setTimeout(killMc, 5000);
        mcServer.once('exit', () => {
            clearTimeout(killTimeout);
        });
        mcPut('stop');
    }
}

function restartMcServer() {
    emitEvent('serverRestart');
    onliner = {};
    clearTimeout(killTimeout);
    startMcServer();
}

function startMcServer() {
    mcServer = childProcess.spawn('java', [
        '--add-modules=jdk.incubator.vector',
        '-XX:+UseG1GC',
        '-XX:+ParallelRefProcEnabled',
        '-XX:MaxGCPauseMillis=200',
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+DisableExplicitGC',
        '-XX:+AlwaysPreTouch',
        '-XX:G1HeapWastePercent=5',
        '-XX:G1MixedGCCountTarget=4',
        '-XX:InitiatingHeapOccupancyPercent=15',
        '-XX:G1MixedGCLiveThresholdPercent=90',
        '-XX:G1RSetUpdatingPauseTimePercent=5',
        '-XX:SurvivorRatio=32',
        '-XX:+PerfDisableSharedMem',
        '-XX:MaxTenuringThreshold=1',
        '-Dusing.aikars.flags=https://mcflags.emc.gs',
        '-Daikars.new.flags=true',
        '-XX:G1NewSizePercent=30',
        '-XX:G1MaxNewSizePercent=40',
        '-XX:G1HeapRegionSize=8M',
        '-XX:G1ReservePercent=20',
        '-jar',
        'server.jar',
        '--nogui'
    ], {
        stdout: 'pipe',
        cwd: path.join(process.cwd(), 'minecraft')
    });
    var buffer = '';
    mcServer.stdin.setEncoding('utf8');
    mcServer.stdout.setEncoding('utf8');
    mcServer.stderr.setEncoding('utf8');
    mcServer.stdout.on('data', onData);
    mcServer.stderr.on('data', onData);

    function onData(data) {
        buffer += data;
        var lines = buffer.split('\n');
        var len = lines.length-1;
        for (var i = 0; i < len; i++) {
            onMcLine(lines[i]);
        }
        buffer = lines[len];
    }
    mcServer.on('exit', restartMcServer);
}

function serverEmpty() {
    for(var online of onliner) {
        return false;
    }
    return true;
}

function mcPut(cmd) {
    mcServer.stdin.write(`${cmd}\n`);
}

function killMc() {
    mcServer.kill();
}

function onMcLine(line) {
    var handler, match;
    for(var i = 0; i < lineHandlers.length; i++) {
        handler = lineHandlers[i];
        match = line.match(handler.re);
        if(match) {
            handler.fn(match);
            return;
        }
    }
    console.info(line);
}

function main() {
    startServer();
    startReadingInput();
    startMcServer();
}