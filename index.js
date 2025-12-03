const express = require('express')
const { spawn } = require('child_process')
const rateLimit = require('express-rate-limit')
const app = express()
const port = 3000

// Track the listener process
let listenerProcess = null
let listenerStatus = 'stopped' // 'stopped', 'running', 'starting', 'stopping'
let listenerLogs = []
const MAX_LOG_LINES = 100

// Rate limiter for listener control endpoints to prevent abuse
const listenerRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 10, // limit each IP to 10 requests per windowMs
  message: { success: false, message: 'Too many requests, please try again later.' }
})

app.use(express.json())

app.get('/', (req, res) => {
  res.send('Hello World!')
})

/**
 * Get the current status of the listener
 * GET /listener/status
 */
app.get('/listener/status', (req, res) => {
  res.json({
    status: listenerStatus,
    pid: listenerProcess ? listenerProcess.pid : null,
    recentLogs: listenerLogs.slice(-20)
  })
})

/**
 * Start the listener process
 * POST /listener/start
 */
app.post('/listener/start', listenerRateLimiter, (req, res) => {
  if (listenerStatus === 'running') {
    return res.status(400).json({
      success: false,
      message: 'Listener is already running',
      pid: listenerProcess ? listenerProcess.pid : null
    })
  }

  try {
    listenerStatus = 'starting'
    listenerLogs = []
    
    // Start the TypeScript listener using ts-node-dev
    listenerProcess = spawn('npm', ['run', 'dev'], {
      cwd: process.cwd(),
      shell: true,
      env: { ...process.env }
    })

    listenerProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim())
      lines.forEach(line => {
        listenerLogs.push(`[stdout] ${new Date().toISOString()} ${line}`)
        if (listenerLogs.length > MAX_LOG_LINES) {
          listenerLogs.shift()
        }
        // Mark as running when we receive initial output from the listener
        if (listenerStatus === 'starting') {
          listenerStatus = 'running'
        }
      })
      console.log(`[Listener] ${data}`)
    })

    listenerProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim())
      lines.forEach(line => {
        listenerLogs.push(`[stderr] ${new Date().toISOString()} ${line}`)
        if (listenerLogs.length > MAX_LOG_LINES) {
          listenerLogs.shift()
        }
      })
      console.error(`[Listener Error] ${data}`)
    })

    listenerProcess.on('close', (code) => {
      listenerLogs.push(`[system] ${new Date().toISOString()} Process exited with code ${code}`)
      listenerStatus = 'stopped'
      listenerProcess = null
      console.log(`[Listener] Process exited with code ${code}`)
    })

    listenerProcess.on('error', (error) => {
      listenerLogs.push(`[error] ${new Date().toISOString()} ${error.message}`)
      listenerStatus = 'stopped'
      listenerProcess = null
      console.error(`[Listener] Failed to start: ${error.message}`)
    })

    res.json({
      success: true,
      message: 'Listener starting...',
      pid: listenerProcess.pid
    })
  } catch (error) {
    listenerStatus = 'stopped'
    res.status(500).json({
      success: false,
      message: `Failed to start listener: ${error.message}`
    })
  }
})

/**
 * Stop the listener process
 * POST /listener/stop
 */
app.post('/listener/stop', listenerRateLimiter, (req, res) => {
  if (!listenerProcess) {
    return res.status(400).json({
      success: false,
      message: 'Listener is not running'
    })
  }

  try {
    const pid = listenerProcess.pid
    listenerStatus = 'stopping'
    listenerLogs.push(`[system] ${new Date().toISOString()} Stop signal sent`)
    listenerProcess.kill('SIGTERM')
    
    res.json({
      success: true,
      message: 'Listener stop signal sent',
      pid: pid
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `Failed to stop listener: ${error.message}`
    })
  }
})

/**
 * Get recent logs from the listener
 * GET /listener/logs
 * Query params:
 *   - lines: number of lines to return (default: 50, max: 100)
 */
app.get('/listener/logs', (req, res) => {
  const parsedLines = parseInt(req.query.lines, 10)
  const lines = Number.isNaN(parsedLines) || parsedLines < 1 ? 50 : Math.min(parsedLines, MAX_LOG_LINES)
  res.json({
    status: listenerStatus,
    logs: listenerLogs.slice(-lines)
  })
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
  console.log(`Listener control endpoints available:`)
  console.log(`  GET  /listener/status - Get listener status`)
  console.log(`  POST /listener/start  - Start the listener`)
  console.log(`  POST /listener/stop   - Stop the listener`)
  console.log(`  GET  /listener/logs   - Get recent logs`)
})
