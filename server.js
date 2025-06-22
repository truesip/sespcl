//
// Session Protocol Voice API Server (Production Ready)
// ---------------------------------------------
// This version uses simple console logging and has no database dependency.
// Version 1.9: Fixed security issues, added validation, and improved error handling.
//

// --- Dependencies ---
const cluster = require('cluster');
const os = require('os');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const helmet = require('helmet');
const NodeCache = require('node-cache');
const pino = require('pino');
const pinoHttp = require('pino-http');
const sip = require('sip');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// High-performance logger
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production' ? {
        target: 'pino-pretty',
        options: { colorize: true }
    } : undefined
});

// Cache for content analysis and transcriptions (TTL: 1 hour)
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// HTTP Agent with connection pooling
const httpAgent = new (require('http').Agent)({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 30000,
    freeSocketTimeout: 15000
});

const httpsAgent = new (require('https').Agent)({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 30000,
    freeSocketTimeout: 15000
});

// Configure axios defaults for connection pooling
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.timeout = 30000;

// --- Environment Variable Validation ---
const requiredEnvVars = ['MY_API_KEY', 'DEFAULT_CALLER_ID'];

// Check which provider to use: VoIP Service, SIP, or Infobip
const useVoIP = process.env.USE_VOIP === 'true';
const useSip = process.env.USE_SIP === 'true';
const voipProvider = process.env.VOIP_PROVIDER || 'twilio'; // twilio, vonage, aws, wavix, plivo, sinch, telnyx, enablex

if (useVoIP) {
    // VoIP service configuration
    if (voipProvider === 'twilio') {
        requiredEnvVars.push('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN');
    } else if (voipProvider === 'vonage') {
        requiredEnvVars.push('VONAGE_API_KEY', 'VONAGE_API_SECRET');
    } else if (voipProvider === 'aws') {
        requiredEnvVars.push('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_CONNECT_INSTANCE_ID');
    } else if (voipProvider === 'wavix') {
        requiredEnvVars.push('WAVIX_API_KEY');
    } else if (voipProvider === 'plivo') {
        requiredEnvVars.push('PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN');
    } else if (voipProvider === 'sinch') {
        requiredEnvVars.push('SINCH_APPLICATION_KEY', 'SINCH_APPLICATION_SECRET');
    } else if (voipProvider === 'telnyx') {
        requiredEnvVars.push('TELNYX_API_KEY', 'TELNYX_CONNECTION_ID');
    } else if (voipProvider === 'enablex') {
        requiredEnvVars.push('ENABLEX_APP_ID', 'ENABLEX_APP_KEY');
    }
} else if (useSip) {
    const sipRequiredVars = ['SIP_PROXY_HOST', 'SIP_USERNAME', 'SIP_PASSWORD', 'SIP_DOMAIN'];
    requiredEnvVars.push(...sipRequiredVars);
} else {
    const infobipRequiredVars = ['INFOBIP_BASE_URL', 'INFOBIP_API_KEY'];
    requiredEnvVars.push(...infobipRequiredVars);
}

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error(`[FATAL] Missing required environment variables: ${missingVars.join(', ')}. Shutting down.`);
    process.exit(1);
}

// Cluster setup for multi-core utilization
if (cluster.isPrimary && process.env.NODE_ENV === 'production') {
    const numCPUs = os.cpus().length;
    const numWorkers = Math.min(numCPUs, parseInt(process.env.WORKER_PROCESSES) || numCPUs);
    
    logger.info(`Master process ${process.pid} starting ${numWorkers} workers`);
    
    // Fork workers
    for (let i = 0; i < numWorkers; i++) {
        cluster.fork();
    }
    
    cluster.on('exit', (worker, code, signal) => {
        logger.warn(`Worker ${worker.process.pid} died. Restarting...`);
        cluster.fork();
    });
    
    return; // Exit master process
}

// --- Express App Initialization ---
const app = express();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false, // Allow API usage
    crossOriginEmbedderPolicy: false
}));

// Compression middleware
app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

// Configure trust proxy settings
// Only trust proxy if we're behind a known proxy (like Nginx, CloudFlare, etc.)
// Set to false for development, or configure properly for production
const trustProxyConfig = process.env.TRUST_PROXY || 'false';
if (trustProxyConfig !== 'false') {
    app.set('trust proxy', trustProxyConfig);
    console.log(`[INFO] Trust proxy configured: ${trustProxyConfig}`);
} else {
    console.log('[INFO] Trust proxy disabled (recommended for direct connections)');
}

// High-scale rate limiting configuration
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX) || 10000, // Much higher limit for production
    message: { error: 'Too many requests from this IP, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: {
        trustProxy: false,
    },
    // Use Redis store for distributed rate limiting in production
    // store: new RedisStore({ ... }) // Uncomment when using Redis
});

// Separate stricter rate limiting for expensive operations
const heavyLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: parseInt(process.env.HEAVY_RATE_LIMIT_MAX) || 100,
    message: { error: 'Too many resource-intensive requests. Please slow down.' },
    validate: { trustProxy: false }
});

app.use(limiter);
app.use(express.json({ 
    limit: '5mb', // Reduced for better memory management
    strict: true
}));
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
    maxAge: 86400 // 24 hours
}));

// High-performance logging middleware
app.use(pinoHttp({ 
    logger,
    // Reduce log verbosity in production for performance
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
    serializers: {
        req: (req) => ({
            method: req.method,
            url: req.url,
            ip: req.ip
        }),
        res: (res) => ({
            statusCode: res.statusCode
        })
    }
}));

const PORT = process.env.PORT || 3000;

// --- Input Validation Helpers ---
const isValidPhoneNumber = (phone) => {
    const phoneRegex = /^\+?[1-9]\d{1,14}$/; // E.164 format
    return phoneRegex.test(phone);
};

const isValidDTMF = (digit) => {
    return /^[0-9*#]$/.test(digit);
};

const isValidUrl = (url) => {
    try {
        const parsedUrl = new URL(url);
        return ['http:', 'https:'].includes(parsedUrl.protocol);
    } catch {
        return false;
    }
};

// --- SIP Client Configuration and Handler ---
class SIPClient {
    constructor() {
        this.sipConfig = {
            proxyHost: process.env.SIP_PROXY_HOST,
            proxyPort: parseInt(process.env.SIP_PROXY_PORT) || 5060,
            username: process.env.SIP_USERNAME,
            password: process.env.SIP_PASSWORD,
            domain: process.env.SIP_DOMAIN,
            fromName: process.env.SIP_FROM_NAME || 'TrueSIP API',
            localPort: parseInt(process.env.SIP_LOCAL_PORT) || 5070,
            transport: process.env.SIP_TRANSPORT || 'UDP'
        };
        this.activeCalls = new Map();
        this.cseq = 1;
        this.registrationStatus = 'UNREGISTERED';
        this.localIP = null;
        this.authRealm = null;
        this.authNonce = null;
        
        // Get local IP address
        this.getLocalIP();
    }
    
    getLocalIP() {
        const os = require('os');
        const interfaces = os.networkInterfaces();
        
        for (const devName in interfaces) {
            const iface = interfaces[devName];
            for (let i = 0; i < iface.length; i++) {
                const alias = iface[i];
                if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                    this.localIP = alias.address;
                    return;
                }
            }
        }
        this.localIP = '127.0.0.1'; // Fallback
    }
    
    generateCallId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}@${this.localIP}`;
    }
    
    generateTag() {
        return Math.random().toString(36).substr(2, 8);
    }
    
    generateBranch() {
        return `z9hG4bK${Math.random().toString(36).substr(2, 16)}`;
    }

    async register() {
        if (this.registrationStatus === 'REGISTERED') {
            return true;
        }
        
        try {
            logger.info({
                proxyHost: this.sipConfig.proxyHost,
                proxyPort: this.sipConfig.proxyPort,
                username: this.sipConfig.username,
                domain: this.sipConfig.domain,
                localIP: this.localIP
            }, 'Starting SIP registration');
            
            const callId = this.generateCallId();
            const fromTag = this.generateTag();
            
            const registerMessage = {
                method: 'REGISTER',
                uri: `sip:${this.sipConfig.domain}`,
                version: '2.0',
                headers: {
                    'Call-ID': callId,
                    'From': `"${this.sipConfig.fromName}" <sip:${this.sipConfig.username}@${this.sipConfig.domain}>;tag=${fromTag}`,
                    'To': `<sip:${this.sipConfig.username}@${this.sipConfig.domain}>`,
                    'CSeq': `${this.cseq++} REGISTER`,
                    'Via': `SIP/2.0/UDP ${this.localIP}:${this.sipConfig.localPort};branch=${this.generateBranch()}`,
                    'Contact': `<sip:${this.sipConfig.username}@${this.localIP}:${this.sipConfig.localPort}>`,
                    'Expires': '3600',
                    'User-Agent': 'TrueSIP-API/1.9',
                    'Max-Forwards': '70'
                }
            };
            
            logger.debug({ registerMessage }, 'Sending REGISTER message');
            
            const response = await this.sendSIPMessage(registerMessage);
            
            logger.info({ 
                status: response.status, 
                reason: response.reason,
                headers: response.headers 
            }, 'Received registration response');
            
            if (response.status === 401 || response.status === 407) {
                // Authentication required
                logger.info('Authentication required, sending credentials');
                return await this.handleAuthChallenge(response, registerMessage);
            } else if (response.status === 200) {
                this.registrationStatus = 'REGISTERED';
                logger.info('SIP registration successful');
                return true;
            } else {
                logger.error({ 
                    status: response.status, 
                    reason: response.reason,
                    headers: response.headers
                }, 'SIP registration failed with unexpected status');
                return false;
            }
            
        } catch (error) {
            logger.error({ 
                error: error.message,
                stack: error.stack,
                sipConfig: {
                    proxyHost: this.sipConfig.proxyHost,
                    proxyPort: this.sipConfig.proxyPort,
                    domain: this.sipConfig.domain,
                    localIP: this.localIP
                }
            }, 'SIP registration error');
            return false;
        }
    }
    
    async handleAuthChallenge(challengeResponse, originalMessage) {
        try {
            // Parse WWW-Authenticate or Proxy-Authenticate header
            const authHeader = challengeResponse.headers['www-authenticate'] || challengeResponse.headers['proxy-authenticate'];
            if (!authHeader) {
                throw new Error('No authentication header found');
            }
            
            // Extract realm and nonce
            const realmMatch = authHeader.match(/realm="([^"]+)"/);
            const nonceMatch = authHeader.match(/nonce="([^"]+)"/);
            
            if (!realmMatch || !nonceMatch) {
                throw new Error('Invalid authentication header format');
            }
            
            this.authRealm = realmMatch[1];
            this.authNonce = nonceMatch[1];
            
            // Generate response hash
            const crypto = require('crypto');
            const uri = originalMessage.uri;
            const method = originalMessage.method;
            
            const ha1 = crypto.createHash('md5').update(`${this.sipConfig.username}:${this.authRealm}:${this.sipConfig.password}`).digest('hex');
            const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
            const response = crypto.createHash('md5').update(`${ha1}:${this.authNonce}:${ha2}`).digest('hex');
            
            // Create authenticated request
            const authMessage = {
                ...originalMessage,
                headers: {
                    ...originalMessage.headers,
                    'CSeq': `${this.cseq++} ${originalMessage.method}`,
                    'Authorization': `Digest username="${this.sipConfig.username}", realm="${this.authRealm}", nonce="${this.authNonce}", uri="${uri}", response="${response}"`
                }
            };
            
            const authResponse = await this.sendSIPMessage(authMessage);
            
            if (authResponse.status === 200) {
                this.registrationStatus = 'REGISTERED';
                logger.info('SIP authentication successful');
                return true;
            } else {
                logger.error({ status: authResponse.status }, 'SIP authentication failed');
                return false;
            }
            
        } catch (error) {
            logger.error({ error: error.message }, 'Authentication challenge handling failed');
            return false;
        }
    }

    async makeCall(to, from, audioContent, options = {}) {
        const callId = this.generateCallId();
        
        try {
            logger.info({ callId, to, from }, 'Initiating SIP call');
            
            // Check if we should skip registration (for providers that block registration)
            const skipRegistration = process.env.SIP_SKIP_REGISTRATION === 'true';
            
            if (!skipRegistration && this.registrationStatus !== 'REGISTERED') {
                logger.info('Attempting SIP registration before call...');
                const registered = await this.register();
                if (!registered) {
                    logger.warn('SIP registration failed, attempting direct call without registration');
                }
            } else if (skipRegistration) {
                logger.info('Skipping SIP registration (SIP_SKIP_REGISTRATION=true)');
            }
            
            const fromTag = this.generateTag();
            const branch = this.generateBranch();
            
            // Create proper SIP INVITE
            const inviteMessage = {
                method: 'INVITE',
                uri: `sip:${to}@${this.sipConfig.domain}`,
                version: '2.0',
                headers: {
                    'Call-ID': callId,
                    'From': `"${this.sipConfig.fromName}" <sip:${from}@${this.sipConfig.domain}>;tag=${fromTag}`,
                    'To': `<sip:${to}@${this.sipConfig.domain}>`,
                    'CSeq': `${this.cseq++} INVITE`,
                    'Via': `SIP/2.0/UDP ${this.localIP}:${this.sipConfig.localPort};branch=${branch}`,
                    'Contact': `<sip:${this.sipConfig.username}@${this.localIP}:${this.sipConfig.localPort}>`,
                    'User-Agent': 'TrueSIP-API/1.9',
                    'Max-Forwards': '70',
                    'Content-Type': 'application/sdp'
                },
                content: this.generateSDP(audioContent, options)
            };
            
            // Add authorization if we have credentials
            if (this.authRealm && this.authNonce) {
                const crypto = require('crypto');
                const uri = inviteMessage.uri;
                const method = 'INVITE';
                
                const ha1 = crypto.createHash('md5').update(`${this.sipConfig.username}:${this.authRealm}:${this.sipConfig.password}`).digest('hex');
                const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
                const response = crypto.createHash('md5').update(`${ha1}:${this.authNonce}:${ha2}`).digest('hex');
                
                inviteMessage.headers['Authorization'] = `Digest username="${this.sipConfig.username}", realm="${this.authRealm}", nonce="${this.authNonce}", uri="${uri}", response="${response}"`;
            }

            // Store call information
            this.activeCalls.set(callId, {
                to,
                from,
                status: 'CALLING',
                startTime: new Date(),
                audioContent,
                options
            });

            const response = await this.sendSIPMessage(inviteMessage);
            
            if (response.status === 100 || response.status === 180 || response.status === 183) {
                // Call in progress
                this.activeCalls.get(callId).status = 'RINGING';
                logger.info({ callId, status: response.status }, 'SIP call in progress');
            } else if (response.status === 200) {
                // Call answered
                this.activeCalls.get(callId).status = 'ANSWERED';
                logger.info({ callId }, 'SIP call answered');
            } else if (response.status >= 400) {
                // Call failed
                this.activeCalls.delete(callId);
                throw new Error(`SIP call failed with status ${response.status}: ${response.reason}`);
            }
            
            return {
                success: true,
                callId,
                status: 'INITIATED',
                tracking: {
                    bulkId: callId,
                    messageId: callId,
                    to,
                    from,
                    timestamp: new Date().toISOString()
                }
            };
            
        } catch (error) {
            logger.error({ callId, error: error.message }, 'SIP call failed');
            
            // Clean up failed call
            this.activeCalls.delete(callId);
            
            throw new Error(`SIP call failed: ${error.message}`);
        }
    }

    generateSDP(audioContent, options) {
        const sessionId = Date.now();
        const version = sessionId;
        
        // Basic SDP for audio call
        let sdp = `v=0\r\n`;
        sdp += `o=TrueSIP ${sessionId} ${version} IN IP4 localhost\r\n`;
        sdp += `s=TrueSIP Call\r\n`;
        sdp += `c=IN IP4 localhost\r\n`;
        sdp += `t=0 0\r\n`;
        sdp += `m=audio 8000 RTP/AVP 0 8\r\n`;
        sdp += `a=rtpmap:0 PCMU/8000\r\n`;
        sdp += `a=rtpmap:8 PCMA/8000\r\n`;
        
        // Add custom attributes for TTS or audio file
        if (audioContent) {
            if (options.isText) {
                sdp += `a=tts-text:${audioContent}\r\n`;
                sdp += `a=tts-voice:${options.voice || 'en-US-AriaNeural'}\r\n`;
            } else {
                sdp += `a=audio-url:${audioContent}\r\n`;
            }
        }
        
        return sdp;
    }

    async sendSIPMessage(message) {
        return new Promise((resolve, reject) => {
            // Create UDP socket for SIP communication
            const dgram = require('dgram');
            const socket = dgram.createSocket('udp4');
            
            let responseReceived = false;
            let timeoutHandle;
            
            // Serialize SIP message
            const sipMessage = this.serializeSIPMessage(message);
            
            logger.debug({
                host: this.sipConfig.proxyHost,
                port: this.sipConfig.proxyPort,
                messageSize: sipMessage.length,
                callId: message.headers['call-id']
            }, 'Sending SIP message');
            
            // Set up timeout first
            timeoutHandle = setTimeout(() => {
                if (!responseReceived) {
                    responseReceived = true;
                    socket.close();
                    logger.error({
                        host: this.sipConfig.proxyHost,
                        port: this.sipConfig.proxyPort,
                        callId: message.headers['call-id']
                    }, 'SIP request timeout - no response from server');
                    reject(new Error(`SIP request timeout - no response from ${this.sipConfig.proxyHost}:${this.sipConfig.proxyPort}`));
                }
            }, 30000); // Increased to 30 seconds
            
            // Listen for response before sending
            socket.on('message', (data, rinfo) => {
                if (!responseReceived) {
                    responseReceived = true;
                    clearTimeout(timeoutHandle);
                    
                    logger.debug({
                        from: `${rinfo.address}:${rinfo.port}`,
                        size: data.length,
                        callId: message.headers['call-id']
                    }, 'Received SIP response');
                    
                    try {
                        const response = this.parseSIPResponse(data.toString());
                        socket.close();
                        resolve(response);
                    } catch (parseError) {
                        logger.error({
                            error: parseError.message,
                            rawData: data.toString().substring(0, 200),
                            callId: message.headers['call-id']
                        }, 'Failed to parse SIP response');
                        socket.close();
                        reject(parseError);
                    }
                }
            });
            
            // Handle socket errors
            socket.on('error', (err) => {
                if (!responseReceived) {
                    responseReceived = true;
                    clearTimeout(timeoutHandle);
                    logger.error({
                        error: err.message,
                        host: this.sipConfig.proxyHost,
                        port: this.sipConfig.proxyPort,
                        callId: message.headers['call-id']
                    }, 'Socket error');
                    socket.close();
                    reject(err);
                }
            });
            
            // Send the message
            socket.send(sipMessage, this.sipConfig.proxyPort, this.sipConfig.proxyHost, (error) => {
                if (error) {
                    if (!responseReceived) {
                        responseReceived = true;
                        clearTimeout(timeoutHandle);
                        logger.error({
                            error: error.message,
                            host: this.sipConfig.proxyHost,
                            port: this.sipConfig.proxyPort,
                            callId: message.headers['call-id']
                        }, 'Failed to send SIP message');
                        socket.close();
                        reject(error);
                    }
                } else {
                    logger.debug({
                        host: this.sipConfig.proxyHost,
                        port: this.sipConfig.proxyPort,
                        callId: message.headers['call-id']
                    }, 'SIP message sent successfully');
                }
            });
        });
    }

    serializeSIPMessage(message) {
        let sipString = `${message.method} ${message.uri} SIP/${message.version}\r\n`;
        
        // Add Content-Length header if content is present
        if (message.content) {
            const contentLength = Buffer.byteLength(message.content, 'utf8');
            message.headers['Content-Length'] = contentLength.toString();
        } else {
            message.headers['Content-Length'] = '0';
        }
        
        // Add headers
        for (const [name, value] of Object.entries(message.headers)) {
            if (Array.isArray(value)) {
                value.forEach(v => {
                    sipString += `${name}: ${this.serializeHeaderValue(v)}\r\n`;
                });
            } else {
                sipString += `${name}: ${this.serializeHeaderValue(value)}\r\n`;
            }
        }
        
        sipString += `\r\n`;
        
        // Add content if present
        if (message.content) {
            sipString += message.content;
        }
        
        logger.debug({ 
            messagePreview: sipString.substring(0, 200) + (sipString.length > 200 ? '...' : ''),
            totalLength: sipString.length 
        }, 'Serialized SIP message');
        
        return Buffer.from(sipString);
    }

    serializeHeaderValue(value) {
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'object') {
            if (value.uri) {
                let result = value.uri;
                if (value.params) {
                    for (const [key, val] of Object.entries(value.params)) {
                        result += `;${key}=${val}`;
                    }
                }
                return result;
            }
            if (value.seq && value.method) {
                return `${value.seq} ${value.method}`;
            }
            if (value.version && value.protocol) {
                let result = `SIP/${value.version}/${value.protocol} ${value.host}`;
                if (value.port) result += `:${value.port}`;
                if (value.params) {
                    for (const [key, val] of Object.entries(value.params)) {
                        result += `;${key}=${val}`;
                    }
                }
                return result;
            }
        }
        return String(value);
    }

    parseSIPResponse(data) {
        const lines = data.split('\r\n');
        const statusLine = lines[0];
        const statusMatch = statusLine.match(/^SIP\/([\d\.]+)\s+(\d+)\s+(.*)$/);
        
        if (!statusMatch) {
            throw new Error('Invalid SIP response format');
        }
        
        return {
            version: statusMatch[1],
            status: parseInt(statusMatch[2]),
            reason: statusMatch[3],
            headers: this.parseHeaders(lines.slice(1))
        };
    }

    parseHeaders(lines) {
        const headers = {};
        for (const line of lines) {
            if (line.trim() === '') break;
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const name = line.substring(0, colonIndex).trim().toLowerCase();
                const value = line.substring(colonIndex + 1).trim();
                headers[name] = value;
            }
        }
        return headers;
    }

    getCallStatus(callId) {
        const call = this.activeCalls.get(callId);
        if (!call) {
            return { error: 'Call not found' };
        }
        
        return {
            callId,
            status: call.status,
            to: call.to,
            from: call.from,
            startTime: call.startTime,
            duration: Date.now() - call.startTime.getTime()
        };
    }

    getAllCalls() {
        return Array.from(this.activeCalls.entries()).map(([callId, call]) => ({
            callId,
            ...call
        }));
    }
    
    async testConnectivity() {
        try {
            logger.info('Testing basic SIP connectivity...');
            
            // First test basic UDP connectivity
            const udpTest = await this.testUDPConnectivity();
            if (!udpTest.success) {
                return udpTest;
            }
            
            // Try to send a simple OPTIONS request to test SIP protocol
            const callId = this.generateCallId();
            
            const optionsMessage = {
                method: 'OPTIONS',
                uri: `sip:${this.sipConfig.domain}`,
                version: '2.0',
                headers: {
                    'Call-ID': callId,
                    'From': `<sip:${this.sipConfig.username}@${this.sipConfig.domain}>;tag=${this.generateTag()}`,
                    'To': `<sip:${this.sipConfig.domain}>`,
                    'CSeq': `${this.cseq++} OPTIONS`,
                    'Via': `SIP/2.0/UDP ${this.localIP}:${this.sipConfig.localPort};branch=${this.generateBranch()}`,
                    'User-Agent': 'TrueSIP-API/1.9',
                    'Max-Forwards': '70'
                }
            };
            
            const response = await this.sendSIPMessage(optionsMessage);
            
            if (response.status === 200 || response.status === 404 || response.status === 405) {
                // Any of these responses indicate connectivity is working
                logger.info('SIP connectivity test successful');
                return { success: true, status: response.status, message: 'SIP server is reachable' };
            } else {
                logger.warn({ status: response.status }, 'SIP connectivity test received unexpected response');
                return { success: false, status: response.status, message: `Unexpected response: ${response.status}` };
            }
            
        } catch (error) {
            logger.error({ error: error.message }, 'SIP connectivity test failed');
            
            // Provide more specific error messages
            if (error.message.includes('timeout')) {
                return { 
                    success: false, 
                    error: error.message, 
                    message: 'Connection timeout - SIP server may be blocking traffic or unreachable',
                    troubleshooting: [
                        'Check if SIP provider allows connections from DigitalOcean IPs',
                        'Verify SIP_PROXY_HOST and SIP_PROXY_PORT are correct',
                        'Contact SIP provider about firewall rules'
                    ]
                };
            } else if (error.message.includes('ECONNREFUSED')) {
                return {
                    success: false,
                    error: error.message,
                    message: 'Connection refused - SIP server is not accepting connections on this port',
                    troubleshooting: [
                        'Verify SIP_PROXY_PORT (should be 5060 for most providers)',
                        'Check if SIP service is running on the server',
                        'Try different port if provider uses non-standard port'
                    ]
                };
            } else {
                return { success: false, error: error.message, message: 'SIP server is not reachable' };
            }
        }
    }
    
    async testUDPConnectivity() {
        return new Promise((resolve) => {
            const dgram = require('dgram');
            const socket = dgram.createSocket('udp4');
            
            // Create a simple test message
            const testMessage = Buffer.from('\r\n\r\n'); // Empty message to test connectivity
            
            let responseReceived = false;
            
            const timeout = setTimeout(() => {
                if (!responseReceived) {
                    responseReceived = true;
                    socket.close();
                    resolve({
                        success: false,
                        error: 'UDP connectivity test timeout',
                        message: `Cannot reach ${this.sipConfig.proxyHost}:${this.sipConfig.proxyPort} via UDP`
                    });
                }
            }, 5000);
            
            socket.on('error', (err) => {
                if (!responseReceived) {
                    responseReceived = true;
                    clearTimeout(timeout);
                    socket.close();
                    resolve({
                        success: false,
                        error: err.message,
                        message: 'UDP socket error'
                    });
                }
            });
            
            socket.on('message', () => {
                if (!responseReceived) {
                    responseReceived = true;
                    clearTimeout(timeout);
                    socket.close();
                    resolve({
                        success: true,
                        message: 'UDP connectivity confirmed'
                    });
                }
            });
            
            socket.send(testMessage, this.sipConfig.proxyPort, this.sipConfig.proxyHost, (error) => {
                if (error && !responseReceived) {
                    responseReceived = true;
                    clearTimeout(timeout);
                    socket.close();
                    resolve({
                        success: false,
                        error: error.message,
                        message: 'Failed to send UDP test packet'
                    });
                }
            });
        });
    }
}

// --- VoIP Service Clients ---
class TwilioClient {
    constructor() {
        this.accountSid = process.env.TWILIO_ACCOUNT_SID;
        this.authToken = process.env.TWILIO_AUTH_TOKEN;
        this.baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`;
        this.activeCalls = new Map();
    }

    async makeCall(to, from, audioContent, options = {}) {
        try {
            logger.info({ to, from, provider: 'Twilio' }, 'Initiating Twilio call');

            let twiml;
            if (options.isText) {
                // Text-to-Speech call
                twiml = `<Response><Say voice="alice">${audioContent}</Say></Response>`;
            } else {
                // Audio file call
                twiml = `<Response><Play>${audioContent}</Play></Response>`;
            }

            // Add transfer logic if specified
            if (options.transferTo && options.dtmfDigit) {
                twiml = `<Response>
                    <Gather numDigits="1" action="/transfer">
                        <Say voice="alice">${audioContent}</Say>
                    </Gather>
                </Response>`;
            }

            const callData = {
                Url: process.env.TWILIO_WEBHOOK_URL || 'http://demo.twilio.com/docs/voice.xml',
                To: to,
                From: from,
                Method: 'POST'
            };

            const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
            
            const response = await axios.post(
                `${this.baseUrl}/Calls.json`,
                new URLSearchParams(callData),
                {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: 10000
                }
            );

            const callSid = response.data.sid;
            
            this.activeCalls.set(callSid, {
                to,
                from,
                status: 'INITIATED',
                startTime: new Date(),
                audioContent,
                options
            });

            logger.info({ callSid, to }, 'Twilio call initiated successfully');

            return {
                success: true,
                callId: callSid,
                status: 'INITIATED',
                tracking: {
                    bulkId: callSid,
                    messageId: callSid,
                    to,
                    from,
                    timestamp: new Date().toISOString()
                }
            };

        } catch (error) {
            logger.error({ error: error.message }, 'Twilio call failed');
            throw new Error(`Twilio call failed: ${error.message}`);
        }
    }

    async getCallStatus(callSid) {
        try {
            const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
            
            const response = await axios.get(
                `${this.baseUrl}/Calls/${callSid}.json`,
                {
                    headers: {
                        'Authorization': `Basic ${auth}`
                    },
                    timeout: 5000
                }
            );

            return {
                callId: callSid,
                status: response.data.status,
                duration: response.data.duration,
                startTime: response.data.start_time,
                endTime: response.data.end_time
            };

        } catch (error) {
            return { error: 'Call not found or error retrieving status' };
        }
    }
}

class VonageClient {
    constructor() {
        this.apiKey = process.env.VONAGE_API_KEY;
        this.apiSecret = process.env.VONAGE_API_SECRET;
        this.baseUrl = 'https://api.nexmo.com/v1/calls';
        this.activeCalls = new Map();
    }

    async makeCall(to, from, audioContent, options = {}) {
        try {
            logger.info({ to, from, provider: 'Vonage' }, 'Initiating Vonage call');

            let ncco;
            if (options.isText) {
                // Text-to-Speech call
                ncco = [{
                    "action": "talk",
                    "text": audioContent,
                    "voiceName": "Amy"
                }];
            } else {
                // Audio file call
                ncco = [{
                    "action": "stream",
                    "streamUrl": [audioContent]
                }];
            }

            const jwt = this.generateJWT();
            
            const callData = {
                to: [{ type: 'phone', number: to }],
                from: { type: 'phone', number: from },
                ncco: ncco
            };

            const response = await axios.post(
                this.baseUrl,
                callData,
                {
                    headers: {
                        'Authorization': `Bearer ${jwt}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            const callUuid = response.data.uuid;
            
            this.activeCalls.set(callUuid, {
                to,
                from,
                status: 'INITIATED',
                startTime: new Date(),
                audioContent,
                options
            });

            logger.info({ callUuid, to }, 'Vonage call initiated successfully');

            return {
                success: true,
                callId: callUuid,
                status: 'INITIATED',
                tracking: {
                    bulkId: callUuid,
                    messageId: callUuid,
                    to,
                    from,
                    timestamp: new Date().toISOString()
                }
            };

        } catch (error) {
            logger.error({ error: error.message }, 'Vonage call failed');
            throw new Error(`Vonage call failed: ${error.message}`);
        }
    }

    generateJWT() {
        // Simplified JWT generation for Vonage
        const crypto = require('crypto');
        const header = Buffer.from(JSON.stringify({"alg":"RS256","typ":"JWT"})).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
            "iat": Math.floor(Date.now() / 1000),
            "exp": Math.floor(Date.now() / 1000) + 3600,
            "iss": this.apiKey
        })).toString('base64url');
        
        // Note: This is simplified. In production, use a proper JWT library
        return `${header}.${payload}.signature`;
    }

    async getCallStatus(callUuid) {
        try {
            const jwt = this.generateJWT();
            
            const response = await axios.get(
                `${this.baseUrl}/${callUuid}`,
                {
                    headers: {
                        'Authorization': `Bearer ${jwt}`
                    },
                    timeout: 5000
                }
            );

            return {
                callId: callUuid,
                status: response.data.status,
                duration: response.data.duration,
                startTime: response.data.start_time,
                endTime: response.data.end_time
            };

        } catch (error) {
            return { error: 'Call not found or error retrieving status' };
        }
    }
}

class WavixClient {
    constructor() {
        this.apiKey = process.env.WAVIX_API_KEY;
        this.baseUrl = process.env.WAVIX_BASE_URL || 'https://api.wavix.com/v1';
        this.activeCalls = new Map();
    }

    async makeCall(to, from, audioContent, options = {}) {
        try {
            logger.info({ to, from, provider: 'Wavix' }, 'Initiating Wavix call');

            let callData;
            if (options.isText) {
                // Text-to-Speech call
                callData = {
                    to: to,
                    from: from,
                    tts: {
                        text: audioContent,
                        voice: options.voice || 'en-US-AriaNeural',
                        speed: options.speed || 1.0
                    }
                };
            } else {
                // Audio file call
                callData = {
                    to: to,
                    from: from,
                    audio_url: audioContent
                };
            }

            // Add transfer logic if specified
            if (options.transferTo && options.dtmfDigit) {
                callData.transfer = {
                    destination: options.transferTo,
                    dtmf_digit: options.dtmfDigit
                };
            }

            const response = await axios.post(
                `${this.baseUrl}/calls`,
                callData,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            const callId = response.data.call_id || response.data.id;
            
            this.activeCalls.set(callId, {
                to,
                from,
                status: 'INITIATED',
                startTime: new Date(),
                audioContent,
                options
            });

            logger.info({ callId, to }, 'Wavix call initiated successfully');

            return {
                success: true,
                callId,
                status: 'INITIATED',
                tracking: {
                    bulkId: callId,
                    messageId: callId,
                    to,
                    from,
                    timestamp: new Date().toISOString()
                }
            };

        } catch (error) {
            logger.error({ error: error.message }, 'Wavix call failed');
            throw new Error(`Wavix call failed: ${error.message}`);
        }
    }

    async getCallStatus(callId) {
        try {
            const response = await axios.get(
                `${this.baseUrl}/calls/${callId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`
                    },
                    timeout: 5000
                }
            );

            return {
                callId,
                status: response.data.status,
                duration: response.data.duration,
                startTime: response.data.start_time,
                endTime: response.data.end_time
            };

        } catch (error) {
            return { error: 'Call not found or error retrieving status' };
        }
    }
}

class PlivoClient {
    constructor() {
        this.authId = process.env.PLIVO_AUTH_ID;
        this.authToken = process.env.PLIVO_AUTH_TOKEN;
        this.baseUrl = 'https://api.plivo.com/v1/Account';
        this.activeCalls = new Map();
    }

    async makeCall(to, from, audioContent, options = {}) {
        try {
            logger.info({ to, from, provider: 'Plivo' }, 'Initiating Plivo call');

            const auth = Buffer.from(`${this.authId}:${this.authToken}`).toString('base64');
            
            let callData = {
                to: to,
                from: from,
                answer_method: 'GET'
            };

            if (options.isText) {
                // Text-to-Speech call - Use Plivo's speak element
                const speakXml = `<?xml version="1.0" encoding="UTF-8"?>
                <Response>
                    <Speak voice="${options.voice || 'WOMAN'}" language="${options.language || 'en-US'}">${audioContent}</Speak>
                </Response>`;
                
                // Create a temporary answer URL or use inline XML
                callData.answer_url = `data:application/xml;base64,${Buffer.from(speakXml).toString('base64')}`;
            } else {
                // Audio file call - Use Plivo's play element
                const playXml = `<?xml version="1.0" encoding="UTF-8"?>
                <Response>
                    <Play>${audioContent}</Play>
                </Response>`;
                
                callData.answer_url = `data:application/xml;base64,${Buffer.from(playXml).toString('base64')}`;
            }

            // Add transfer logic if specified
            if (options.transferTo && options.dtmfDigit) {
                const transferXml = `<?xml version="1.0" encoding="UTF-8"?>
                <Response>
                    <Speak>Press ${options.dtmfDigit} to be transferred</Speak>
                    <GetDigits action="/plivo/transfer/${options.transferTo}" method="POST" numDigits="1">
                        <Speak>Enter your choice</Speak>
                    </GetDigits>
                    <Speak>Thank you for calling</Speak>
                </Response>`;
                
                callData.answer_url = `data:application/xml;base64,${Buffer.from(transferXml).toString('base64')}`;
            }

            const response = await axios.post(
                `${this.baseUrl}/${this.authId}/Call/`,
                callData,
                {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            const callUuid = response.data.request_uuid;
            
            this.activeCalls.set(callUuid, {
                to,
                from,
                status: 'INITIATED',
                startTime: new Date(),
                audioContent,
                options
            });

            logger.info({ callUuid, to }, 'Plivo call initiated successfully');

            return {
                success: true,
                callId: callUuid,
                status: 'INITIATED',
                tracking: {
                    bulkId: callUuid,
                    messageId: callUuid,
                    to,
                    from,
                    timestamp: new Date().toISOString()
                }
            };

        } catch (error) {
            logger.error({ error: error.message }, 'Plivo call failed');
            throw new Error(`Plivo call failed: ${error.message}`);
        }
    }

    async getCallStatus(callUuid) {
        try {
            const auth = Buffer.from(`${this.authId}:${this.authToken}`).toString('base64');
            
            const response = await axios.get(
                `${this.baseUrl}/${this.authId}/Call/${callUuid}/`,
                {
                    headers: {
                        'Authorization': `Basic ${auth}`
                    },
                    timeout: 5000
                }
            );

            return {
                callId: callUuid,
                status: response.data.call_status,
                duration: response.data.duration,
                startTime: response.data.start_time,
                endTime: response.data.end_time,
                totalCost: response.data.total_cost
            };

        } catch (error) {
            return { error: 'Call not found or error retrieving status' };
        }
    }
}

class SinchClient {
    constructor() {
        this.applicationKey = process.env.SINCH_APPLICATION_KEY;
        this.applicationSecret = process.env.SINCH_APPLICATION_SECRET;
        this.baseUrl = 'https://calling.api.sinch.com/calling/v1';
        this.activeCalls = new Map();
    }

    async makeCall(to, from, audioContent, options = {}) {
        try {
            logger.info({ to, from, provider: 'Sinch' }, 'Initiating Sinch call');

            // Generate timestamp and authorization
            const timestamp = new Date().toISOString();
            const auth = this.generateAuth('POST', '/calling/v1/callouts', '', timestamp);

            let callData;
            if (options.isText) {
                // Text-to-Speech call using Sinch SVAML
                callData = {
                    method: 'ttsCallout',
                    ttsCallout: {
                        cli: from,
                        destination: {
                            type: 'number',
                            endpoint: to
                        },
                        text: audioContent,
                        locale: options.locale || 'en-US',
                        prompts: options.voice || '#male1'
                    }
                };
            } else {
                // Audio file call using custom callback
                callData = {
                    method: 'customCallout',
                    customCallout: {
                        cli: from,
                        destination: {
                            type: 'number',
                            endpoint: to
                        },
                        custom: `data:application/json;base64,${Buffer.from(JSON.stringify({
                            instructions: [{
                                name: 'playFiles',
                                files: [{ id: audioContent }]
                            }]
                        })).toString('base64')}`
                    }
                };
            }

            // Add IVR logic if specified
            if (options.transferTo && options.dtmfDigit) {
                if (options.isText) {
                    callData.ttsCallout.custom = `data:application/json;base64,${Buffer.from(JSON.stringify({
                        instructions: [
                            {
                                name: 'say',
                                text: audioContent,
                                locale: options.locale || 'en-US'
                            },
                            {
                                name: 'runMenu',
                                barge: true,
                                menus: [{
                                    id: 'main',
                                    mainPrompt: '#tts[Press ' + options.dtmfDigit + ' to be transferred]',
                                    options: [{
                                        dtmf: options.dtmfDigit,
                                        action: 'connectPstn',
                                        number: options.transferTo
                                    }]
                                }]
                            }
                        ]
                    })).toString('base64')}`;
                }
            }

            const response = await axios.post(
                `${this.baseUrl}/callouts`,
                callData,
                {
                    headers: {
                        'Authorization': auth,
                        'Content-Type': 'application/json',
                        'X-Timestamp': timestamp
                    },
                    timeout: 10000
                }
            );

            const callId = response.data.callId;
            
            this.activeCalls.set(callId, {
                to,
                from,
                status: 'INITIATED',
                startTime: new Date(),
                audioContent,
                options
            });

            logger.info({ callId, to }, 'Sinch call initiated successfully');

            return {
                success: true,
                callId,
                status: 'INITIATED',
                tracking: {
                    bulkId: callId,
                    messageId: callId,
                    to,
                    from,
                    timestamp: new Date().toISOString()
                }
            };

        } catch (error) {
            logger.error({ error: error.message }, 'Sinch call failed');
            throw new Error(`Sinch call failed: ${error.message}`);
        }
    }

    generateAuth(method, path, body, timestamp) {
        const crypto = require('crypto');
        
        // Create content hash
        const contentHash = crypto.createHash('md5').update(body).digest('base64');
        
        // Create string to sign
        const stringToSign = `${method}\n${contentHash}\napplication/json\nx-timestamp:${timestamp}\n${path}`;
        
        // Create signature
        const signature = crypto.createHmac('sha256', Buffer.from(this.applicationSecret, 'base64'))
            .update(stringToSign, 'utf8')
            .digest('base64');
        
        return `Application ${this.applicationKey}:${signature}`;
    }

    async getCallStatus(callId) {
        try {
            const timestamp = new Date().toISOString();
            const auth = this.generateAuth('GET', `/calling/v1/calls/id/${callId}`, '', timestamp);
            
            const response = await axios.get(
                `${this.baseUrl}/calls/id/${callId}`,
                {
                    headers: {
                        'Authorization': auth,
                        'X-Timestamp': timestamp
                    },
                    timeout: 5000
                }
            );

            return {
                callId,
                status: response.data.status,
                duration: response.data.duration,
                startTime: response.data.createTime,
                endTime: response.data.endTime,
                result: response.data.result
            };

        } catch (error) {
            return { error: 'Call not found or error retrieving status' };
        }
    }
}

class TelnyxClient {
    constructor() {
        this.apiKey = process.env.TELNYX_API_KEY;
        this.baseUrl = 'https://api.telnyx.com/v2';
        this.activeCalls = new Map();
    }

    async makeCall(to, from, audioContent, options = {}) {
        try {
            logger.info({ to, from, provider: 'Telnyx' }, 'Initiating Telnyx call');

            let callData = {
                to: to,
                from: from,
                connection_id: process.env.TELNYX_CONNECTION_ID,
                webhook_url: process.env.TELNYX_WEBHOOK_URL || 'https://your-app.com/webhook/telnyx',
                webhook_url_method: 'POST'
            };

            if (options.isText) {
                // Text-to-Speech call using Telnyx answering machine detection
                callData.answering_machine_detection = 'premium';
                callData.answering_machine_detection_config = {
                    total_analysis_time_millis: 4000,
                    after_greeting_silence_millis: 800,
                    greeting_duration_millis: 3500,
                    initial_silence_millis: 3500,
                    maximum_number_of_words: 5,
                    silence_threshold: 256
                };
                
                // Store TTS content for webhook processing
                callData.custom_headers = [{
                    name: 'X-TTS-Text',
                    value: Buffer.from(audioContent).toString('base64')
                }, {
                    name: 'X-Voice-Type',
                    value: options.voice || 'alice'
                }];
            } else {
                // Audio file call
                callData.custom_headers = [{
                    name: 'X-Audio-URL',
                    value: audioContent
                }];
            }

            // Add transfer logic if specified
            if (options.transferTo && options.dtmfDigit) {
                callData.custom_headers.push({
                    name: 'X-Transfer-To',
                    value: options.transferTo
                }, {
                    name: 'X-DTMF-Digit',
                    value: options.dtmfDigit
                });
            }

            const response = await axios.post(
                `${this.baseUrl}/calls`,
                callData,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            const callId = response.data.data.call_control_id;
            
            this.activeCalls.set(callId, {
                to,
                from,
                status: 'INITIATED',
                startTime: new Date(),
                audioContent,
                options
            });

            logger.info({ callId, to }, 'Telnyx call initiated successfully');

            return {
                success: true,
                callId,
                status: 'INITIATED',
                tracking: {
                    bulkId: callId,
                    messageId: callId,
                    to,
                    from,
                    timestamp: new Date().toISOString()
                }
            };

        } catch (error) {
            logger.error({ error: error.message }, 'Telnyx call failed');
            throw new Error(`Telnyx call failed: ${error.message}`);
        }
    }

    async answerCall(callControlId) {
        try {
            const response = await axios.post(
                `${this.baseUrl}/calls/${callControlId}/actions/answer`,
                {},
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 5000
                }
            );

            return response.data;
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to answer Telnyx call');
            throw error;
        }
    }

    async speakText(callControlId, text, voice = 'alice') {
        try {
            const response = await axios.post(
                `${this.baseUrl}/calls/${callControlId}/actions/speak`,
                {
                    payload: text,
                    voice: voice,
                    language: 'en-US'
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 5000
                }
            );

            return response.data;
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to speak text in Telnyx call');
            throw error;
        }
    }

    async playAudio(callControlId, audioUrl) {
        try {
            const response = await axios.post(
                `${this.baseUrl}/calls/${callControlId}/actions/playback_start`,
                {
                    audio_url: audioUrl
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 5000
                }
            );

            return response.data;
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to play audio in Telnyx call');
            throw error;
        }
    }

    async hangupCall(callControlId) {
        try {
            const response = await axios.post(
                `${this.baseUrl}/calls/${callControlId}/actions/hangup`,
                {},
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 5000
                }
            );

            return response.data;
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to hangup Telnyx call');
            throw error;
        }
    }

    async getCallStatus(callControlId) {
        try {
            const response = await axios.get(
                `${this.baseUrl}/calls/${callControlId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`
                    },
                    timeout: 5000
                }
            );

            return {
                callId: callControlId,
                status: response.data.data.call_session_id ? 'ACTIVE' : 'COMPLETED',
                duration: response.data.data.duration,
                startTime: response.data.data.start_time,
                endTime: response.data.data.end_time,
                direction: response.data.data.direction
            };

        } catch (error) {
            return { error: 'Call not found or error retrieving status' };
        }
    }
}

class EnableXClient {
    constructor() {
        this.appId = process.env.ENABLEX_APP_ID;
        this.appKey = process.env.ENABLEX_APP_KEY;
        this.baseUrl = 'https://api.enablex.io/voice/v1';
        this.activeCalls = new Map();
    }

    generateToken() {
        const crypto = require('crypto');
        const timestamp = Math.floor(Date.now() / 1000);
        const randomString = crypto.randomBytes(16).toString('hex');
        
        // Create signature for EnableX authentication
        const stringToSign = `${this.appId}:${timestamp}:${randomString}`;
        const signature = crypto.createHmac('sha256', this.appKey)
            .update(stringToSign)
            .digest('hex');
        
        return Buffer.from(`${this.appId}:${timestamp}:${randomString}:${signature}`).toString('base64');
    }

    async makeCall(to, from, audioContent, options = {}) {
        try {
            logger.info({ to, from, provider: 'EnableX' }, 'Initiating EnableX call');

            const token = this.generateToken();
            
            let callData = {
                to: [{
                    type: 'pstn',
                    number: to
                }],
                from: from,
                event_url: process.env.ENABLEX_WEBHOOK_URL || 'https://your-app.com/webhook/enablex',
                answer_url: process.env.ENABLEX_ANSWER_URL || 'https://your-app.com/answer/enablex'
            };

            if (options.isText) {
                // Text-to-Speech call using EnableX NCCO
                const ncco = [
                    {
                        action: 'talk',
                        text: audioContent,
                        voice_name: options.voice || 'Amy',
                        language: options.language || 'en-US',
                        style: options.style || 0
                    }
                ];
                
                // Add transfer logic if specified
                if (options.transferTo && options.dtmfDigit) {
                    ncco.push({
                        action: 'input',
                        type: ['dtmf'],
                        dtmf: {
                            max_digits: 1,
                            timeout_ms: 5000
                        },
                        event_url: [`${process.env.ENABLEX_WEBHOOK_URL}/dtmf`]
                    });
                    ncco.push({
                        action: 'connect',
                        endpoint: [{
                            type: 'phone',
                            number: options.transferTo
                        }]
                    });
                }
                
                callData.ncco = ncco;
            } else {
                // Audio file call
                const ncco = [
                    {
                        action: 'stream',
                        stream_url: [audioContent],
                        level: options.volume || 0,
                        bargeIn: options.bargeIn || false
                    }
                ];
                
                callData.ncco = ncco;
            }

            const response = await axios.post(
                `${this.baseUrl}/calls`,
                callData,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            const callId = response.data.uuid || response.data.call_uuid;
            
            this.activeCalls.set(callId, {
                to,
                from,
                status: 'INITIATED',
                startTime: new Date(),
                audioContent,
                options
            });

            logger.info({ callId, to }, 'EnableX call initiated successfully');

            return {
                success: true,
                callId,
                status: 'INITIATED',
                tracking: {
                    bulkId: callId,
                    messageId: callId,
                    to,
                    from,
                    timestamp: new Date().toISOString()
                }
            };

        } catch (error) {
            logger.error({ error: error.message }, 'EnableX call failed');
            throw new Error(`EnableX call failed: ${error.message}`);
        }
    }

    async modifyCall(callId, action, params = {}) {
        try {
            const token = this.generateToken();
            
            const response = await axios.put(
                `${this.baseUrl}/calls/${callId}`,
                {
                    action: action,
                    ...params
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 5000
                }
            );

            return response.data;
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to modify EnableX call');
            throw error;
        }
    }

    async hangupCall(callId) {
        try {
            const token = this.generateToken();
            
            const response = await axios.delete(
                `${this.baseUrl}/calls/${callId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    timeout: 5000
                }
            );

            return response.data;
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to hangup EnableX call');
            throw error;
        }
    }

    async getCallStatus(callId) {
        try {
            const token = this.generateToken();
            
            const response = await axios.get(
                `${this.baseUrl}/calls/${callId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    timeout: 5000
                }
            );

            return {
                callId,
                status: response.data.status,
                duration: response.data.duration,
                startTime: response.data.start_time,
                endTime: response.data.end_time,
                direction: response.data.direction,
                price: response.data.price
            };

        } catch (error) {
            return { error: 'Call not found or error retrieving status' };
        }
    }

    async getCallRecording(callId) {
        try {
            const token = this.generateToken();
            
            const response = await axios.get(
                `${this.baseUrl}/calls/${callId}/recordings`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    timeout: 5000
                }
            );

            return response.data;
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to get EnableX call recording');
            return { error: 'Recording not found' };
        }
    }
}

class AWSConnectClient {
    constructor() {
        this.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
        this.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
        this.region = process.env.AWS_REGION || 'us-east-1';
        this.instanceId = process.env.AWS_CONNECT_INSTANCE_ID;
        this.activeCalls = new Map();
    }

    async makeCall(to, from, audioContent, options = {}) {
        try {
            logger.info({ to, from, provider: 'AWS Connect' }, 'Initiating AWS Connect call');

            // AWS Connect requires more complex setup
            // This is a simplified implementation
            const callId = uuidv4();
            
            // Store call information
            this.activeCalls.set(callId, {
                to,
                from,
                status: 'INITIATED',
                startTime: new Date(),
                audioContent,
                options
            });

            // Note: AWS Connect integration would require AWS SDK
            // This is a placeholder implementation
            
            return {
                success: true,
                callId,
                status: 'INITIATED',
                tracking: {
                    bulkId: callId,
                    messageId: callId,
                    to,
                    from,
                    timestamp: new Date().toISOString()
                }
            };

        } catch (error) {
            logger.error({ error: error.message }, 'AWS Connect call failed');
            throw new Error(`AWS Connect call failed: ${error.message}`);
        }
    }

    async getCallStatus(callId) {
        const call = this.activeCalls.get(callId);
        if (!call) {
            return { error: 'Call not found' };
        }
        
        return {
            callId,
            status: call.status,
            to: call.to,
            from: call.from,
            startTime: call.startTime,
            duration: Date.now() - call.startTime.getTime()
        };
    }
}

// Initialize clients based on configuration
let voipClient = null;
let sipClient = null;

if (useVoIP) {
    if (voipProvider === 'twilio') {
        voipClient = new TwilioClient();
        logger.info('Twilio VoIP client initialized');
    } else if (voipProvider === 'vonage') {
        voipClient = new VonageClient();
        logger.info('Vonage VoIP client initialized');
    } else if (voipProvider === 'aws') {
        voipClient = new AWSConnectClient();
        logger.info('AWS Connect VoIP client initialized');
    } else if (voipProvider === 'wavix') {
        voipClient = new WavixClient();
        logger.info('Wavix VoIP client initialized');
    } else if (voipProvider === 'plivo') {
        voipClient = new PlivoClient();
        logger.info('Plivo VoIP client initialized');
    } else if (voipProvider === 'sinch') {
        voipClient = new SinchClient();
        logger.info('Sinch VoIP client initialized');
    } else if (voipProvider === 'telnyx') {
        voipClient = new TelnyxClient();
        logger.info('Telnyx VoIP client initialized');
    } else if (voipProvider === 'enablex') {
        voipClient = new EnableXClient();
        logger.info('EnableX VoIP client initialized');
    }
} else if (useSip) {
    sipClient = new SIPClient();
    logger.info('SIP client initialized');
}

// --- API Key Authentication Middleware ---
const apiKeyAuth = (req, res, next) => {
    const userApiKey = req.headers['x-api-key'];
    if (!userApiKey || !process.env.MY_API_KEY || userApiKey !== process.env.MY_API_KEY) {
        req.log.warn({ ip: req.ip }, 'Unauthorized access attempt');
        return res.status(401).json({ error: 'Unauthorized. Invalid or missing API Key.' });
    }
    next();
};

// --- Helper Function for Content Analysis (with caching) ---
async function analyzeContent(text, logger) {
    const perspectiveApiKey = process.env.PERSPECTIVE_API_KEY;
    if (!perspectiveApiKey) {
        logger.debug('Perspective API key not found, skipping content analysis.');
        return { passed: true };
    }

    // Check cache first
    const cacheKey = `content:${Buffer.from(text).toString('base64').slice(0, 32)}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        logger.debug('Content analysis result from cache');
        return cached;
    }

    try {
        logger.debug('Analyzing content with Perspective API...');
        const perspectiveApiUrl = 'https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze';
        const perspectiveRequest = {
            comment: { text },
            languages: ['en'],
            requestedAttributes: { 'TOXICITY': {}, 'SPAM': {}, 'PROFANITY': {}, 'THREAT': {}, 'SEXUALLY_EXPLICIT': {} }
        };

        const perspectiveResponse = await axios.post(perspectiveApiUrl, perspectiveRequest, {
            headers: {
                'Content-Type': 'application/json'
            },
            params: {
                key: perspectiveApiKey
            },
            timeout: 5000 // Shorter timeout for high-scale
        });
        
        const scores = perspectiveResponse.data.attributeScores;
        const threshold = parseFloat(process.env.PERSPECTIVE_THRESHOLD) || 0.8;

        let result = { passed: true };
        
        for (const attribute in scores) {
            if (scores[attribute].summaryScore.value > threshold) {
                logger.warn(`Message flagged for ${attribute}. Score: ${scores[attribute].summaryScore.value}`);
                result = { passed: false, error: `Message flagged as inappropriate (${attribute}).` };
                break;
            }
        }
        
        // Cache the result
        cache.set(cacheKey, result);
        logger.debug('Content analysis completed');
        return result;

    } catch (error) {
        logger.error({ error: error.message }, 'Perspective API request failed');
        // In high-scale, consider allowing requests to proceed if content analysis fails
        const fallbackResult = { passed: process.env.CONTENT_ANALYSIS_REQUIRED !== 'true', error: 'Content analysis could not be performed.' };
        return fallbackResult;
    }
}

// --- Helper Function for Audio Processing (optimized with streaming) ---
async function processAudioFile(audioUrl, logger) {
    const speechApiKey = process.env.GOOGLE_SPEECH_API_KEY;
    if (!speechApiKey) {
        logger.debug('Google Speech API key not found, skipping audio transcription.');
        return { success: false, transcript: '' };
    }

    // Check cache first
    const cacheKey = `audio:${Buffer.from(audioUrl).toString('base64').slice(0, 32)}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        logger.debug('Audio transcription result from cache');
        return cached;
    }

    try {
        logger.debug(`Processing audio from URL: ${audioUrl}`);
        
        // Download with stricter limits for high-scale
        const audioResponse = await axios.get(audioUrl, { 
            responseType: 'arraybuffer',
            maxContentLength: 5 * 1024 * 1024, // Reduced to 5MB for better memory management
            timeout: 15000, // Reduced timeout
            maxRedirects: 3
        });
        
        // Process in chunks to avoid memory issues
        const audioData = audioResponse.data;
        if (audioData.length > 5 * 1024 * 1024) {
            throw new Error('Audio file too large for processing');
        }
        
        const audioBytes = Buffer.from(audioData).toString('base64');
        logger.debug('Transcribing audio...');
        
        const speechApiUrl = 'https://speech.googleapis.com/v1/speech:recognize';
        
        // Auto-detect format
        const contentType = audioResponse.headers['content-type'] || '';
        let encoding = 'LINEAR16';
        let sampleRate = 16000;
        
        if (contentType.includes('mp3') || audioUrl.toLowerCase().includes('.mp3')) {
            encoding = 'MP3';
        } else if (contentType.includes('wav') || audioUrl.toLowerCase().includes('.wav')) {
            encoding = 'LINEAR16';
        } else if (contentType.includes('flac') || audioUrl.toLowerCase().includes('.flac')) {
            encoding = 'FLAC';
        }
        
        const speechRequest = {
            audio: { content: audioBytes },
            config: { 
                encoding: encoding, 
                sampleRateHertz: sampleRate, 
                languageCode: 'en-US',
                enableAutomaticPunctuation: true,
                model: 'latest_short' // Optimized for shorter audio
            }
        };
        
        const speechResponse = await axios.post(speechApiUrl, speechRequest, {
            headers: {
                'Content-Type': 'application/json'
            },
            params: {
                key: speechApiKey
            },
            timeout: 10000 // Shorter timeout
        });
        
        const transcript = speechResponse.data.results?.[0]?.alternatives[0]?.transcript || '';
        const result = { success: true, transcript };
        
        // Cache the result
        cache.set(cacheKey, result);
        return result;
        
    } catch (error) {
        logger.error({ error: error.message }, 'Audio processing failed');
        const errorResult = { success: false, transcript: '', error: 'Failed to process audio file.' };
        return errorResult;
    }
}


// --- API Routes ---

/**
 * @route   POST /api/v1/call/tts
 * @desc    Initiates a voice call using TTS, an audio file, or with IVR transfer.
 * @access  Private (Requires API Key)
 */
app.post('/api/v1/call/tts', apiKeyAuth, heavyLimiter, async (req, res) => {
    const { to, text, from, audioUrl, transferToNumber, dtmfTransferDigit } = req.body;

    // Input validation
    if (!to || (!text && !audioUrl)) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: 'Missing required fields: `to` and either `text` or `audioUrl` are required.' 
        });
    }
    
    // Validate phone numbers
    if (!isValidPhoneNumber(to)) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: 'Invalid phone number format for `to` field. Use E.164 format.' 
        });
    }
    
    if (from && !isValidPhoneNumber(from)) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: 'Invalid phone number format for `from` field. Use E.164 format.' 
        });
    }
    
    // Validate transfer number
    if (transferToNumber && !isValidPhoneNumber(transferToNumber)) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: 'Invalid phone number format for `transferToNumber` field. Use E.164 format.' 
        });
    }
    
    // Validate DTMF digit
    if (dtmfTransferDigit && !isValidDTMF(dtmfTransferDigit)) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: 'Invalid DTMF digit. Must be 0-9, *, or #.' 
        });
    }
    
    // Validate audio URL
    if (audioUrl && !isValidUrl(audioUrl)) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: 'Invalid audio URL format.' 
        });
    }
    
    // Validate IVR parameters
    if ((transferToNumber && !dtmfTransferDigit) || (!transferToNumber && dtmfTransferDigit)) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: 'For IVR transfer, both `transferToNumber` and `dtmfTransferDigit` are required.' 
        });
    }
    
    // IVR transfers cannot be used with pre-recorded audio files
    if (transferToNumber && audioUrl) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: 'IVR call transfers cannot be used with an audioUrl. Please use `text` for the prompt.' 
        });
    }

    let messageContent = text;

    // --- AUDIO TRANSCRIPTION & ANALYSIS ---
    if (audioUrl) {
        const audioResult = await processAudioFile(audioUrl, req.log);
        if (!audioResult.success) {
            return res.status(500).json({ 
                error: 'Audio processing failed', 
                details: audioResult.error || 'Failed to process audio file.' 
            });
        }
        if (audioResult.transcript) {
            messageContent = audioResult.transcript;
        }
    }

    // Content analysis for both text and transcribed audio
    if (messageContent) {
        const analysisResult = await analyzeContent(messageContent, req.log);
        if (!analysisResult.passed) {
            return res.status(400).json({ 
                error: 'Content validation failed', 
                details: analysisResult.error 
            });
        }
    }
    
    const callerId = from || process.env.DEFAULT_CALLER_ID;
    
    // Route to VoIP service if enabled, then SIP, then Infobip
    if (useVoIP && voipClient) {
        try {
            req.log.info({ to, provider: voipProvider.toUpperCase() }, `Routing call via ${voipProvider.toUpperCase()}`);
            
            const voipOptions = {
                isText: !!text,
                voice: 'en-US-AriaNeural',
                transferTo: transferToNumber,
                dtmfDigit: dtmfTransferDigit
            };
            
            const audioContent = text || audioUrl;
            const voipResult = await voipClient.makeCall(to, callerId, audioContent, voipOptions);
            
            req.log.info({ callId: voipResult.callId, to }, `${voipProvider.toUpperCase()} call initiated successfully`);
            return res.status(200).json({
                message: `Call initiated successfully via ${voipProvider.toUpperCase()}.`,
                provider: voipProvider.toUpperCase(),
                tracking: voipResult.tracking,
                processedBy: `worker-${process.pid}`
            });
            
        } catch (voipError) {
            req.log.error({ to, error: voipError.message }, `${voipProvider.toUpperCase()} call failed`);
            return res.status(500).json({
                error: `${voipProvider.toUpperCase()} call failed`,
                details: voipError.message,
                provider: voipProvider.toUpperCase()
            });
        }
    } else if (useSip && sipClient) {
        try {
            req.log.info({ to, provider: 'SIP' }, 'Routing call via SIP');
            
            const sipOptions = {
                isText: !!text,
                voice: 'en-US-AriaNeural',
                transferTo: transferToNumber,
                dtmfDigit: dtmfTransferDigit
            };
            
            const audioContent = text || audioUrl;
            const sipResult = await sipClient.makeCall(to, callerId, audioContent, sipOptions);
            
            req.log.info({ callId: sipResult.callId, to }, 'SIP call initiated successfully');
            return res.status(200).json({
                message: 'Call initiated successfully via SIP.',
                provider: 'SIP',
                tracking: sipResult.tracking,
                processedBy: `worker-${process.pid}`
            });
            
        } catch (sipError) {
            req.log.error({ to, error: sipError.message }, 'SIP call failed');
            return res.status(500).json({
                error: 'SIP call failed',
                details: sipError.message,
                provider: 'SIP'
            });
        }
    }
    
    // Fallback to Infobip if SIP is not enabled
    const infobipHeaders = { 'Authorization': `App ${process.env.INFOBIP_API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };
    
    let infobipApiUrl = `https://${process.env.INFOBIP_BASE_URL}/tts/3/advanced`;
    let infobipPayload;

    // --- Construct Payload based on call type ---
    if (transferToNumber && dtmfTransferDigit) {
        // IVR Call
        console.log(`[INFO] Preparing IVR call to ${to}, transferring to ${transferToNumber} on digit ${dtmfTransferDigit}`);
        infobipPayload = {
            messages: [{
                from: callerId,
                destinations: [{ to }],
                text: text, // IVR must use text
                language: "en",
                voice: { name: "Joanna", gender: "female" },
                callTransfers: [{
                    destination: { type: "PHONE", number: transferToNumber },
                    dtmf: dtmfTransferDigit
                }]
            }]
        };

    } else if (audioUrl) {
        // Simple Audio File Call
        console.log(`[INFO] Preparing audio file call to ${to}`);
        infobipPayload = { messages: [{ from: callerId, destinations: [{ to }], audioFileUrl: audioUrl }] };

    } else {
        // Simple TTS Call (using a different endpoint)
        console.log(`[INFO] Preparing TTS call to ${to}`);
        infobipApiUrl = `https://${process.env.INFOBIP_BASE_URL}/tts/3/single`;
        infobipPayload = { from: callerId, to, text, language: 'en', voice: { name: "Joanna", gender: "female" } };
    }

    // --- Send Request to Infobip ---
    try {
        req.log.info({ to }, 'Sending request to Infobip');
        const infobipResponse = await axios.post(infobipApiUrl, infobipPayload, { 
            headers: infobipHeaders,
            timeout: 10000 // Shorter timeout for high-scale
        });
        
        req.log.info({ to, bulkId: infobipResponse.data.bulkId }, 'Call initiated successfully');
        res.status(200).json({ 
            message: 'Call initiated successfully.', 
            tracking: infobipResponse.data,
            processedBy: `worker-${process.pid}`
        });

    } catch (error) {
        const statusCode = error.response ? error.response.status : 500;
        const errorMessage = error.response ? error.response.data : 'Internal Server Error';
        req.log.error({ to, statusCode, error: errorMessage }, 'Failed to call Infobip');
        res.status(statusCode).json({ 
            error: 'Call initiation failed', 
            details: 'Failed to initiate call via backend service.',
            statusCode: statusCode
        });
    }
});

/**
 * @route   GET /api/v1/call/status/:bulkId
 * @desc    Get call status and reports for a specific bulk ID
 * @access  Private (Requires API Key)
 */
app.get('/api/v1/call/status/:bulkId', apiKeyAuth, async (req, res) => {
    const { bulkId } = req.params;
    
    if (!bulkId || typeof bulkId !== 'string' || bulkId.trim().length === 0) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: 'Missing or invalid bulkId parameter.' 
        });
    }
    
    // Check if it's a SIP call first
    if (useSip && sipClient) {
        const sipStatus = sipClient.getCallStatus(bulkId);
        if (!sipStatus.error) {
            req.log.info({ callId: bulkId, provider: 'SIP' }, 'Retrieved SIP call status');
            return res.status(200).json({
                provider: 'SIP',
                callId: bulkId,
                ...sipStatus
            });
        }
    }
    
    // Fallback to Infobip status check
    const infobipHeaders = { 
        'Authorization': `App ${process.env.INFOBIP_API_KEY}`, 
        'Accept': 'application/json' 
    };
    const infobipReportsUrl = `https://${process.env.INFOBIP_BASE_URL}/tts/3/reports?bulkId=${encodeURIComponent(bulkId.trim())}`;

    try {
        req.log.info({ bulkId, provider: 'Infobip' }, 'Fetching call status');
        const reportsResponse = await axios.get(infobipReportsUrl, { 
            headers: infobipHeaders,
            timeout: 5000
        });
        res.status(200).json({
            provider: 'Infobip',
            ...reportsResponse.data
        });
    } catch (error) {
        const statusCode = error.response?.status || 500;
        const errorDetails = error.response?.data || 'Internal Server Error';
        req.log.error({ bulkId, statusCode }, 'Failed to fetch call status');
        res.status(statusCode).json({ 
            error: 'Status retrieval failed', 
            details: 'Failed to get call status.',
            statusCode: statusCode
        });
    }
});

/**
 * @route   GET /api/v1/sip/calls
 * @desc    Get all active SIP calls (SIP mode only)
 * @access  Private (Requires API Key)
 */
app.get('/api/v1/sip/calls', apiKeyAuth, (req, res) => {
    if (!useSip || !sipClient) {
        return res.status(400).json({
            error: 'SIP not enabled',
            details: 'SIP routing is not enabled on this server.'
        });
    }
    
    const activeCalls = sipClient.getAllCalls();
    res.status(200).json({
        provider: 'SIP',
        totalCalls: activeCalls.length,
        calls: activeCalls
    });
});

/**
 * @route   GET /api/v1/server/config
 * @desc    Get server configuration and provider status
 * @access  Private (Requires API Key)
 */
app.get('/api/v1/server/config', apiKeyAuth, (req, res) => {
    res.status(200).json({
        provider: useSip ? 'SIP' : 'Infobip',
        sipEnabled: useSip,
        infobipEnabled: !useSip,
        version: '1.9-hybrid',
        features: {
            contentAnalysis: !!process.env.PERSPECTIVE_API_KEY,
            audioTranscription: !!process.env.GOOGLE_SPEECH_API_KEY,
            sipRouting: useSip,
            infobipRouting: !useSip
        },
        sipConfig: useSip ? {
            proxyHost: process.env.SIP_PROXY_HOST,
            proxyPort: process.env.SIP_PROXY_PORT,
            domain: process.env.SIP_DOMAIN,
            transport: process.env.SIP_TRANSPORT
        } : null
    });
});

/**
 * @route   POST /api/v1/sip/test
 * @desc    Test SIP connectivity and registration
 * @access  Private (Requires API Key)
 */
app.post('/api/v1/sip/test', apiKeyAuth, async (req, res) => {
    if (!useSip || !sipClient) {
        return res.status(400).json({
            error: 'SIP not enabled',
            details: 'SIP routing is not enabled on this server.'
        });
    }
    
    try {
        logger.info('Testing SIP connectivity and registration...');
        
        // Test basic connectivity first
        const connectivityTest = await sipClient.testConnectivity();
        
        // Test registration
        const registrationTest = await sipClient.register();
        
        res.status(200).json({
            sipTest: {
                connectivity: connectivityTest,
                registration: registrationTest,
                localIP: sipClient.localIP,
                config: {
                    proxyHost: sipClient.sipConfig.proxyHost,
                    proxyPort: sipClient.sipConfig.proxyPort,
                    domain: sipClient.sipConfig.domain,
                    username: sipClient.sipConfig.username
                },
                registrationStatus: sipClient.registrationStatus
            }
        });
        
    } catch (error) {
        logger.error({ error: error.message }, 'SIP test failed');
        res.status(500).json({
            error: 'SIP test failed',
            details: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        version: '1.9-optimized',
        worker: process.pid,
        uptime: process.uptime(),
        memory: {
            used: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
        },
        cacheStats: {
            keys: cache.keys().length,
            hits: cache.getStats().hits,
            misses: cache.getStats().misses
        }
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Not found', 
        details: 'The requested endpoint does not exist.' 
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('[ERROR] Unhandled error:', err.message);
    res.status(500).json({ 
        error: 'Internal server error', 
        details: 'An unexpected error occurred.' 
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    server.close(() => {
        logger.info('Process terminated');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    server.close(() => {
        logger.info('Process terminated');
        process.exit(0);
    });
});

const server = app.listen(PORT, () => {
    logger.info({
        port: PORT,
        worker: process.pid,
        env: process.env.NODE_ENV,
        version: '1.9-optimized'
    }, 'TTS API Server started');
    
    // Log optional features status
    if (process.env.PERSPECTIVE_API_KEY) {
        logger.info('Content analysis (Perspective API) enabled');
    } else {
        logger.warn('Content analysis disabled (no Perspective API key)');
    }
    
    if (process.env.GOOGLE_SPEECH_API_KEY) {
        logger.info('Audio transcription (Google Speech API) enabled');
    } else {
        logger.warn('Audio transcription disabled (no Google Speech API key)');
    }
    
    // Performance monitoring
    if (process.env.NODE_ENV === 'production') {
        setInterval(() => {
            const memUsage = process.memoryUsage();
            const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
            if (heapUsedMB > 1500) { // Alert if using >1.5GB
                logger.warn({ heapUsedMB }, 'High memory usage detected');
            }
        }, 30000); // Check every 30 seconds
    }
});
