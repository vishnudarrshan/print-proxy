require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 5001;

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  path: '/ws', // WebSocket endpoint
  clientTracking: true
});

// CORS configuration
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'WEBSOCKET'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Upgrade']
}));

app.options('*', cors());
app.use(express.json());

// Environment configurations with fallbacks for REACT_APP_ prefixes
const ENVIRONMENTS = {
  previewUat: {
    name: 'Preview UAT',
    baseUrl: process.env.API_URL_PREVIEW_UAT || process.env.REACT_APP_API_URL_PREVIEW_UAT || 'https://preview-uat-print.api.apteancloud.com',
    authType: 'bearer',
    accountId: process.env.UAT_ACCOUNT_ID || process.env.REACT_APP_UAT_ACCOUNT_ID,
    apiKey: process.env.UAT_API_KEY || process.env.REACT_APP_UAT_API_KEY,
    agentKey: process.env.UAT_AGENT_KEY || process.env.REACT_APP_UAT_AGENT_KEY,
    validateCredentials: function() {
      return this.accountId && this.apiKey && this.agentKey;
    },
    getMissingCredentials: function() {
      const missing = [];
      if (!this.accountId) missing.push('accountId');
      if (!this.apiKey) missing.push('apiKey');
      if (!this.agentKey) missing.push('agentKey');
      return missing;
    }
  },
  production: {
    name: 'Production',
    baseUrl: process.env.API_URL_PRODUCTION || process.env.REACT_APP_API_URL_PRODUCTION || 'https://print.api.apteancloud.com',
    authType: 'basic',
    accountId: process.env.PROD_ACCOUNT_ID || process.env.REACT_APP_PROD_ACCOUNT_ID,
    apiKey: process.env.PROD_API_KEY || process.env.REACT_APP_PROD_API_KEY,
    agentKey: process.env.PROD_AGENT_KEY || process.env.REACT_APP_PROD_AGENT_KEY || '',
    validateCredentials: function() {
      return this.accountId && this.apiKey;
    },
    getMissingCredentials: function() {
      const missing = [];
      if (!this.accountId) missing.push('accountId');
      if (!this.apiKey) missing.push('apiKey');
      return missing;
    }
  }
};

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`🔌 New WebSocket client connected from ${clientIp}`);

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connection',
    message: 'Connected to Aptean Proxy WebSocket',
    timestamp: new Date().toISOString()
  }));

  // Handle incoming messages
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('📨 WebSocket message received:', data.type);

      // Handle different message types
      switch (data.type) {
        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: new Date().toISOString()
          }));
          break;

        case 'login':
          // Handle login via WebSocket
          const loginResult = await handleAutoLogin(data.environment);
          ws.send(JSON.stringify({
            type: 'login-result',
            ...loginResult,
            timestamp: new Date().toISOString()
          }));
          break;

        case 'subscribe':
          // Subscribe to updates for a specific environment
          ws.subscriptions = ws.subscriptions || [];
          if (data.environment && !ws.subscriptions.includes(data.environment)) {
            ws.subscriptions.push(data.environment);
            ws.send(JSON.stringify({
              type: 'subscribed',
              environment: data.environment,
              message: `Subscribed to ${data.environment} updates`,
              timestamp: new Date().toISOString()
            }));
          }
          break;

        default:
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Unknown message type',
            timestamp: new Date().toISOString()
          }));
      }
    } catch (error) {
      console.error('❌ WebSocket message error:', error.message);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format',
        error: error.message,
        timestamp: new Date().toISOString()
      }));
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    console.log('🔌 WebSocket client disconnected');
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
  });
});

// Broadcast to all connected clients
function broadcastToAll(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Broadcast to specific environment subscribers
function broadcastToEnvironment(environment, message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && 
        client.subscriptions && 
        client.subscriptions.includes(environment)) {
      client.send(JSON.stringify(message));
    }
  });
}

// Helper function for auto-login
async function handleAutoLogin(environment = 'previewUat') {
  try {
    const env = ENVIRONMENTS[environment];
    
    if (!env) {
      return { 
        success: false, 
        error: 'Invalid environment specified' 
      };
    }
    
    if (!env.validateCredentials()) {
      const missing = env.getMissingCredentials();
      return { 
        success: false,
        error: `Missing required credentials for ${env.name}`,
        missing: missing
      };
    }
    
    const loginPayload = {
      accountId: env.accountId,
      apiKey: env.apiKey
    };
    
    if (env.agentKey) {
      loginPayload.agentKey = env.agentKey;
    } else if (env.name === 'Preview UAT') {
      loginPayload.agentKey = '';
    }
    
    const response = await axios({
      method: 'POST',
      url: `${env.baseUrl}/api/v1/print/login`,
      headers: {
        'Content-Type': 'application/json',
        'accept': '*/*'
      },
      data: loginPayload,
      timeout: 15000
    });
    
    if (!response.data.token) {
      throw new Error('No token received in response');
    }
    
    const fullToken = response.data.token;
    const jwtToken = fullToken.replace('Bearer ', '').trim();
    
    // Broadcast successful login to subscribers
    broadcastToEnvironment(environment, {
      type: 'login-success',
      environment: env.name,
      timestamp: new Date().toISOString()
    });
    
    return {
      success: true,
      environment: env.name,
      token: fullToken,
      jwt: jwtToken
    };
    
  } catch (error) {
    console.error('❌ Auto-login error:', error.message);
    
    let errorMessage = error.message;
    let errorDetails = {};
    
    if (error.response) {
      errorDetails = error.response.data;
      errorMessage = `API Error ${error.response.status}: ${JSON.stringify(error.response.data)}`;
    } else if (error.request) {
      errorMessage = 'No response from API server';
    }
    
    return {
      success: false,
      error: errorMessage,
      details: errorDetails
    };
  }
}

// REST Endpoints
app.get('/', (req, res) => {
  res.json({
    name: 'Aptean Print Proxy Server',
    version: '2.0.0',
    server: `https://${req.get('host')}`,
    features: {
      rest: true,
      websocket: true
    },
    endpoints: {
      rest: {
        health: '/health',
        debug: '/api/proxy/debug',
        autoLogin: '/api/proxy/auto-login',
        testLogin: '/api/proxy/test-login',
        register: '/api/proxy/register'
      },
      websocket: {
        url: `wss://${req.get('host')}/ws`,
        protocols: ['ping', 'login', 'subscribe']
      }
    },
    cors: 'Any origin allowed'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    connections: {
      websocket: wss.clients.size
    },
    environments: {
      previewUat: {
        configured: ENVIRONMENTS.previewUat.validateCredentials(),
        missing: ENVIRONMENTS.previewUat.getMissingCredentials()
      },
      production: {
        configured: ENVIRONMENTS.production.validateCredentials(),
        missing: ENVIRONMENTS.production.getMissingCredentials()
      }
    }
  });
});

app.get('/api/proxy/debug', (req, res) => {
  res.json({
    server: {
      url: `https://${req.get('host')}`,
      status: 'running',
      timestamp: new Date().toISOString(),
      websocketConnections: wss.clients.size
    },
    previewUat: {
      name: ENVIRONMENTS.previewUat.name,
      baseUrl: ENVIRONMENTS.previewUat.baseUrl,
      accountId: ENVIRONMENTS.previewUat.accountId ? '✓ Loaded' : '✗ Missing - REQUIRED',
      apiKey: ENVIRONMENTS.previewUat.apiKey ? '✓ Loaded' : '✗ Missing - REQUIRED',
      agentKey: ENVIRONMENTS.previewUat.agentKey ? '✓ Loaded' : '✗ Missing - REQUIRED',
      isValid: ENVIRONMENTS.previewUat.validateCredentials(),
      requirements: 'All three credentials are REQUIRED'
    },
    production: {
      name: ENVIRONMENTS.production.name,
      baseUrl: ENVIRONMENTS.production.baseUrl,
      accountId: ENVIRONMENTS.production.accountId ? '✓ Loaded' : '✗ Missing - REQUIRED',
      apiKey: ENVIRONMENTS.production.apiKey ? '✓ Loaded' : '✗ Missing - REQUIRED',
      agentKey: ENVIRONMENTS.production.agentKey ? '✓ Loaded (Optional)' : 'Not loaded (Optional)',
      isValid: ENVIRONMENTS.production.validateCredentials(),
      requirements: 'Only accountId and apiKey are REQUIRED'
    },
    websocket: {
      enabled: true,
      path: '/ws',
      currentConnections: wss.clients.size,
      maxConnections: 'Unlimited'
    }
  });
});

app.post('/api/proxy/auto-login', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  
  try {
    const { environment = 'previewUat' } = req.body;
    const result = await handleAutoLogin(environment);
    
    if (result.success) {
      // Broadcast to WebSocket clients
      broadcastToAll({
        type: 'rest-login',
        environment: result.environment,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      ...result,
      proxyServer: `https://${req.get('host')}`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/proxy/test-login', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  
  try {
    const { environment = 'previewUat' } = req.body;
    const env = ENVIRONMENTS[environment];
    
    if (!env) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid environment' 
      });
    }
    
    const testResponse = await axios({
      method: 'OPTIONS',
      url: `${env.baseUrl}/api/v1/print/login`,
      timeout: 5000
    });
    
    res.json({
      success: true,
      environment: env.name,
      reachable: true,
      status: testResponse.status,
      message: `${env.baseUrl} is reachable`
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Cannot reach ${req.body.environment} API`,
      details: error.message
    });
  }
});

app.post('/api/proxy/register', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  
  try {
    const { token, userData, environment = 'previewUat', credentials } = req.body;
    const env = ENVIRONMENTS[environment];
    
    if (!env) {
      return res.status(400).json({ error: 'Invalid environment' });
    }
    
    const headers = {
      'Content-Type': 'application/json',
      'accept': '*/*'
    };
    
    if (environment === 'production' && credentials) {
      const basicAuth = Buffer.from(`${credentials.accountId}:${credentials.apiKey}`).toString('base64');
      headers['Authorization'] = `Basic ${basicAuth}`;
    } else if (environment === 'previewUat' && token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      return res.status(400).json({ error: 'Missing authentication' });
    }
    
    const response = await axios({
      method: 'POST',
      url: `${env.baseUrl}/api/v1/print/register`,
      headers: headers,
      data: userData
    });
    
    // Broadcast registration to WebSocket clients
    broadcastToEnvironment(environment, {
      type: 'registration',
      company: userData.company,
      timestamp: new Date().toISOString()
    });
    
    res.json({
      ...response.data,
      environment: env.name
    });
    
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: error.message,
      details: error.response?.data
    });
  }
});

// WebSocket endpoint info
app.get('/ws-info', (req, res) => {
  res.json({
    websocket: {
      url: `wss://${req.get('host')}/ws`,
      protocols: ['ping', 'login', 'subscribe'],
      example: {
        ping: { type: 'ping' },
        login: { type: 'login', environment: 'previewUat' },
        subscribe: { type: 'subscribe', environment: 'production' }
      },
      currentConnections: wss.clients.size
    }
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  🚀 Aptean Proxy Server Started!
  📍 HTTP Port: ${PORT}
  🔌 WebSocket Port: ${PORT} (same server)
  🌐 Public URL: https://print-proxy-server.onrender.com
  
  📡 WebSocket Endpoint: wss://print-proxy-server.onrender.com/ws
  
  🔓 CORS: Any origin allowed
  
  📋 Credential Status:
  
  🔵 Preview UAT:
     Account ID: ${ENVIRONMENTS.previewUat.accountId ? '✓ Loaded' : '✗ MISSING'}
     API Key: ${ENVIRONMENTS.previewUat.apiKey ? '✓ Loaded' : '✗ MISSING'}
     Agent Key: ${ENVIRONMENTS.previewUat.agentKey ? '✓ Loaded' : '✗ MISSING'}
     Status: ${ENVIRONMENTS.previewUat.validateCredentials() ? '✅ Ready' : '❌ Not Ready'}
  
  🔴 Production:
     Account ID: ${ENVIRONMENTS.production.accountId ? '✓ Loaded' : '✗ MISSING'}
     API Key: ${ENVIRONMENTS.production.apiKey ? '✓ Loaded' : '✗ MISSING'}
     Agent Key: ${ENVIRONMENTS.production.agentKey ? '✓ Loaded' : '✗ MISSING'}
     Status: ${ENVIRONMENTS.production.validateCredentials() ? '✅ Ready' : '❌ Not Ready'}
  
  📍 Test Endpoints:
     GET  https://print-proxy-server.onrender.com/
     GET  https://print-proxy-server.onrender.com/health
     GET  https://print-proxy-server.onrender.com/api/proxy/debug
     GET  https://print-proxy-server.onrender.com/ws-info
     POST https://print-proxy-server.onrender.com/api/proxy/auto-login
     WS   wss://print-proxy-server.onrender.com/ws
  `);
});