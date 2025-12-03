# GitHub Codespaces ♥️ Express

Welcome to your shiny new Codespace running Express! We've got everything fired up and running for you to explore Express.

You've got a blank canvas to work on from a git perspective as well. There's a single initial commit with the what you're seeing right now - where you go from here is up to you!

Everything you do here is contained within this one codespace. There is no repository on GitHub yet. If and when you're ready you can click "Publish Branch" and we'll create your repository and push up your project. If you were just exploring then and have no further need for this code then you can simply delete your codespace and it's gone forever.

## Running the Application

### Start the Express server with listener control

```
npm start
```

This starts the Express server on port 3000 with the following control endpoints:

### Listener Control Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/listener/status` | GET | Get the current listener status, PID, and recent logs |
| `/listener/start` | POST | Start the blockchain event listener |
| `/listener/stop` | POST | Stop the running listener |
| `/listener/logs` | GET | Get recent logs (optional query param: `lines=N`) |

### Examples

```bash
# Check listener status
curl http://localhost:3000/listener/status

# Start the listener
curl -X POST http://localhost:3000/listener/start

# Get last 10 log lines
curl "http://localhost:3000/listener/logs?lines=10"

# Stop the listener
curl -X POST http://localhost:3000/listener/stop
```

### Run the listener directly

```
npm run dev
```

This runs the TypeScript listener directly using ts-node-dev.

### Build and run compiled TypeScript

```
npm run build
npm run start:ts
```
