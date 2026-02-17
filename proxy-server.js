// proxy-server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.REACT_APP_PROXY_URL || 5001;

// Environment configurations with proper validation
const ENVIRONMENTS = {
  previewUat: {
    name: 'Preview UAT',
    baseUrl: process.env.API_URL_PREVIEW_UAT || 'https://preview-uat-print.api.apteancloud.com',
    authType: 'bearer',
    // ✅ ALL THREE REQUIRED for Preview UAT
    accountId: process.env.UAT_ACCOUNT_ID,
    apiKey: process.env.UAT_API_KEY,
    agentKey: process.env.UAT_AGENT_KEY,
    // Validation function
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
    baseUrl: process.env.API_URL_PRODUCTION || 'https://print.api.apteancloud.com',
    authType: 'basic',
    // ✅ ONLY accountId and apiKey required for Production
    accountId: process.env.PROD_ACCOUNT_ID,
    apiKey: process.env.PROD_API_KEY,
    agentKey: process.env.PROD_AGENT_KEY || '', // Optional
    // Validation function
    validateCredentials: function() {
      return this.accountId && this.apiKey; // Only check accountId and apiKey
    },
    getMissingCredentials: function() {
      const missing = [];
      if (!this.accountId) missing.push('accountId');
      if (!this.apiKey) missing.push('apiKey');
      return missing;
    }
  }
};

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());

// Debug endpoint to check loaded credentials
app.get('/api/proxy/debug', (req, res) => {
  const debugInfo = {
    previewUat: {
      name: ENVIRONMENTS.previewUat.name,
      accountId: ENVIRONMENTS.previewUat.accountId ? '✓ Loaded' : '✗ Missing - REQUIRED',
      apiKey: ENVIRONMENTS.previewUat.apiKey ? '✓ Loaded' : '✗ Missing - REQUIRED',
      agentKey: ENVIRONMENTS.previewUat.agentKey ? '✓ Loaded' : '✗ Missing - REQUIRED',
      isValid: ENVIRONMENTS.previewUat.validateCredentials(),
      requirements: 'All three credentials are REQUIRED'
    },
    production: {
      name: ENVIRONMENTS.production.name,
      accountId: ENVIRONMENTS.production.accountId ? '✓ Loaded' : '✗ Missing - REQUIRED',
      apiKey: ENVIRONMENTS.production.apiKey ? '✓ Loaded' : '✗ Missing - REQUIRED',
      agentKey: ENVIRONMENTS.production.agentKey ? '✓ Loaded (Optional)' : 'Not loaded (Optional)',
      isValid: ENVIRONMENTS.production.validateCredentials(),
      requirements: 'Only accountId and apiKey are REQUIRED'
    }
  };
  res.json(debugInfo);
});

// ✅ AUTO-LOGIN ENDPOINT (Handles both environments correctly)
app.post('/api/proxy/auto-login', async (req, res) => {
  try {
    const { environment = 'previewUat' } = req.body;
    const env = ENVIRONMENTS[environment];
    
    if (!env) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid environment specified' 
      });
    }
    
    console.log(`🔐 Auto-login request for ${env.name}`);
    
    // Validate credentials based on environment
    if (!env.validateCredentials()) {
      const missing = env.getMissingCredentials();
      return res.status(400).json({ 
        success: false,
        error: `Missing required credentials for ${env.name}`,
        missing: missing,
        requirements: env.name === 'previewUat' 
          ? 'Preview UAT requires: accountId, apiKey, AND agentKey'
          : 'Production requires: accountId AND apiKey (agentKey is optional)'
      });
    }
    
    // ✅ Prepare EXACT request format for API
    const loginPayload = {
      accountId: env.accountId,
      apiKey: env.apiKey
    };
    
    // ✅ Add agentKey ONLY if it exists (required for UAT, optional for Production)
    if (env.agentKey) {
      loginPayload.agentKey = env.agentKey;
    } else if (env.name === 'Preview UAT') {
      // For UAT, agentKey is required even if empty string
      loginPayload.agentKey = '';
    }
    
    console.log('📤 Login Payload for', env.name + ':', JSON.stringify(loginPayload, null, 2));
    console.log(`📤 Sending to: ${env.baseUrl}/api/v1/print/login`);
    
    // Make API request
    const response = await axios({
      method: 'POST',
      url: `${env.baseUrl}/api/v1/print/login`,
      headers: {
        'Content-Type': 'application/json',
        'accept': '*/*',
        'User-Agent': 'Aptean-Proxy-Server/1.0'
      },
      data: loginPayload,
      timeout: 15000,
      validateStatus: function (status) {
        return status < 500; // Resolve only if status code is less than 500
      }
    });
    
    console.log('📥 Response Status:', response.status);
    console.log('📥 Response Data:', JSON.stringify(response.data, null, 2));
    
    // Check if we got a token
    if (!response.data.token) {
      throw new Error('No token received in response');
    }
    
    // Extract token
    const fullToken = response.data.token;
    const jwtToken = fullToken.replace('Bearer ', '').trim();
    
    console.log(`✅ Auto-login successful for ${env.name}`);
    console.log(`✅ Token length: ${jwtToken.length} characters`);
    
    // Return success response
    res.json({
      success: true,
      environment: env.name,
      token: fullToken,
      jwt: jwtToken,
      message: `Token generated successfully for ${env.name}`,
      timestamp: new Date().toISOString(),
      requirementsMet: env.name === 'previewUat' 
        ? 'All three credentials used (accountId, apiKey, agentKey)'
        : 'AccountId and apiKey used (agentKey is optional)'
    });
    
  } catch (error) {
    console.error('❌ Auto-login error:', error.message);
    
    let statusCode = 500;
    let errorMessage = error.message;
    let errorDetails = {};
    
    if (error.response) {
      // Server responded with error
      statusCode = error.response.status;
      errorDetails = error.response.data;
      console.error('❌ Server Response:', error.response.data);
      console.error('❌ Server Status:', error.response.status);
      errorMessage = `API Error ${error.response.status}: ${JSON.stringify(error.response.data)}`;
    } else if (error.request) {
      // Request made but no response
      console.error('❌ No response from server');
      errorMessage = 'No response from API server. Check network connection and API URL.';
      errorDetails = { 
        suggestion: 'Verify the API endpoint is accessible and CORS is configured'
      };
    } else {
      // Request setup error
      console.error('❌ Request setup failed:', error.message);
      errorMessage = `Request failed: ${error.message}`;
    }
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: errorDetails,
      environment: req.body.environment || 'unknown',
      timestamp: new Date().toISOString()
    });
  }
});

// Test endpoint to verify connectivity
app.post('/api/proxy/test-login', async (req, res) => {
  try {
    const { environment = 'previewUat' } = req.body;
    const env = ENVIRONMENTS[environment];
    
    if (!env) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid environment' 
      });
    }
    
    // Just test connectivity without actually logging in
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

// Existing register endpoint (unchanged)
app.post('/api/proxy/register', async (req, res) => {
  try {
    const { token, userData, environment = 'previewUat', credentials } = req.body;
    const env = ENVIRONMENTS[environment];
    
    if (!env) {
      return res.status(400).json({ error: 'Invalid environment' });
    }
    
    console.log(`📝 Register request for ${env.name} - ${userData.company}`);
    
    const headers = {
      'Content-Type': 'application/json',
      'accept': '*/*'
    };
    
    if (environment === 'production' && credentials) {
      // Production uses Basic Auth
      const basicAuth = Buffer.from(`${credentials.accountId}:${credentials.apiKey}`).toString('base64');
      headers['Authorization'] = `Basic ${basicAuth}`;
    } else if (environment === 'previewUat' && token) {
      // Preview UAT uses Bearer token
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
    
    res.json({
      ...response.data,
      environment: env.name
    });
    
  } catch (error) {
    console.error('❌ Register error:', error.message);
    res.status(error.response?.status || 500).json({
      error: error.message,
      details: error.response?.data
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
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
  };
  res.json(health);
});

app.listen(PORT, () => {
  console.log(`
  🚀 Aptean Proxy Server Started!
  📍 Port: ${PORT}
  🌐 URL: http://localhost:${PORT}
  
  📋 Credential Status:
  
  🔵 Preview UAT:
     URL: ${ENVIRONMENTS.previewUat.baseUrl}
     Account ID: ${ENVIRONMENTS.previewUat.accountId ? '✓ Loaded' : '✗ MISSING - REQUIRED'}
     API Key: ${ENVIRONMENTS.previewUat.apiKey ? '✓ Loaded' : '✗ MISSING - REQUIRED'}
     Agent Key: ${ENVIRONMENTS.previewUat.agentKey ? '✓ Loaded' : '✗ MISSING - REQUIRED'}
     Status: ${ENVIRONMENTS.previewUat.validateCredentials() ? '✅ Ready' : '❌ Not Ready'}
  
  🔴 Production:
     URL: ${ENVIRONMENTS.production.baseUrl}
     Account ID: ${ENVIRONMENTS.production.accountId ? '✓ Loaded' : '✗ MISSING - REQUIRED'}
     API Key: ${ENVIRONMENTS.production.apiKey ? '✓ Loaded' : '✗ MISSING - REQUIRED'}
     Agent Key: ${ENVIRONMENTS.production.agentKey ? '✓ Loaded (Optional)' : 'Not loaded (Optional)'}
     Status: ${ENVIRONMENTS.production.validateCredentials() ? '✅ Ready' : '❌ Not Ready'}
  
  📍 Test Endpoints:
     GET  http://localhost:${PORT}/health
     GET  http://localhost:${PORT}/api/proxy/debug
     POST http://localhost:${PORT}/api/proxy/auto-login
     POST http://localhost:${PORT}/api/proxy/test-login
  `);
});