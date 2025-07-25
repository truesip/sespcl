//
// Session Protocol Voice API Server (Production Ready)
// ---------------------------------------------
// This version uses simple console logging and has no database dependency.
// Version 1.9.1: Corrected EnableX API integration.
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

// Number blocklist cache
const blocklist = new Set();
let blocklistLastUpdated = null;

// Word blocklist cache
const wordBlocklist = new Set();
let wordBlocklistLastUpdated = null;

// Function to download and cache blocklist numbers
async function downloadBlocklist() {
    try {
        logger.info('Downloading blocklist numbers from TrueSIP...');
        const response = await axios.get('https://dial.truesip.net/blocklist-numbers/', {
            timeout: 10000,
            headers: {
                'User-Agent': 'SESPCL-API-Server/1.9.1'
            }
        });
        
        // Clear existing blocklist
        blocklist.clear();
        
        // Parse the response - extract from HTML content
        let numbers = [];
        const data = response.data.toString();
        
        // Extract numbers from HTML - look for the actual number list in the content
        const numberPattern = /\b\d{10,15}\b/g;
        const extractedNumbers = data.match(numberPattern) || [];
        
        // Also try to find comma-separated list in the content
        const csvMatch = data.match(/([\d,\s]+)/g);
        if (csvMatch) {
            csvMatch.forEach(match => {
                if (match.includes(',') && match.length > 20) { // Likely a CSV of numbers
                    const csvNumbers = match.split(',').map(num => num.trim()).filter(num => /^\d{10,15}$/.test(num));
                    numbers.push(...csvNumbers);
                }
            });
        }
        
        // Fallback to extracted individual numbers
        if (numbers.length === 0) {
            numbers = extractedNumbers;
        }
        
        // Remove duplicates
        numbers = [...new Set(numbers)];
        
        logger.debug(`Extracted ${numbers.length} numbers from blocklist source`);
        logger.debug(`Sample numbers: ${numbers.slice(0, 5).join(', ')}`);
        
        if (numbers.length === 0) {
            logger.warn('No valid phone numbers found in blocklist response');
            return; // Don't clear existing blocklist if we can't parse new data
        }
        
        // Add numbers to blocklist with validation
        let validCount = 0;
        numbers.forEach(num => {
            // Basic phone number validation (remove common prefixes and format)
            const cleanNum = num.replace(/^\+?1?/, '').replace(/[^\d]/g, '');
            if (cleanNum.length >= 10) {
                blocklist.add(num); // Store original format
                blocklist.add(cleanNum); // Store cleaned format
                blocklist.add(`+${cleanNum}`); // Store with + prefix
                blocklist.add(`+1${cleanNum}`); // Store with +1 prefix
                validCount++;
            }
        });
        
        logger.info(`Successfully loaded ${validCount} blocked numbers (${blocklist.size} total variations)`);
        blocklistLastUpdated = new Date().toISOString();
        
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to download blocklist numbers');
        // Don't throw error - let server continue without blocklist
    }
}

// Function to download and cache blocked words
async function downloadWordBlocklist() {
    try {
        logger.info('Downloading blocked words from TrueSIP...');
        const response = await axios.get('https://dial.truesip.net/blocklist-words/', {
            timeout: 10000,
            headers: {
                'User-Agent': 'SESPCL-API-Server/1.9.1'
            }
        });
        
        // Clear existing word blocklist
        wordBlocklist.clear();
        
        // Parse the response - extract from HTML content
        const data = response.data.toString();
        let words = [];
        
        // Look for the specific pattern that contains the blocked words list
        // The content appears to be in a specific section with comma-separated values
        const longListPattern = /Publishers Clearing House,.*?Zippy,/s;
        const match = data.match(longListPattern);
        
        if (match) {
            // Found the main blocklist - split by commas and clean up
            const rawWords = match[0].split(',').map(word => word.trim());
            
            words = rawWords.filter(word => {
                // Filter out empty strings and very short words
                if (!word || word.length < 2) return false;
                
                // Keep meaningful words/phrases, filter out HTML artifacts
                return !word.includes('<') && 
                       !word.includes('>') && 
                       !word.includes('function') &&
                       !word.includes('var ') &&
                       !/^[0-9\s.,;:(){}\[\]"']+$/.test(word) && // Skip pure punctuation/numbers
                       word.replace(/[^a-zA-Z0-9\s&'.-]/g, '').length >= 2;
            });
            
            logger.debug(`Found main blocklist with ${words.length} entries`);
        }
        
        // Fallback: Look for other patterns if main list not found
        if (words.length === 0) {
            // Try to find comma-separated lists in the content
            const contentMatches = data.match(/([A-Za-z0-9\s&',.-]+(?:,\s*[A-Za-z0-9\s&',.-]+){5,})/g);
            
            if (contentMatches) {
                contentMatches.forEach(contentMatch => {
                    if (contentMatch.includes(',') && contentMatch.length > 100) {
                        const extractedWords = contentMatch.split(',').map(word => word.trim()).filter(word => {
                            return word.length > 1 && 
                                   !word.includes('<') && 
                                   !word.includes('>') && 
                                   !/^\d+$/.test(word) &&
                                   word.replace(/[^a-zA-Z0-9\s&'.-]/g, '').length > 1;
                        });
                        words.push(...extractedWords);
                    }
                });
            }
        }
        
        // Fallback: Extract individual suspicious words/phrases from the content
        if (words.length === 0) {
            // Look for specific patterns that indicate blocked content
            const suspiciousPatterns = [
                /Publishers\s+Clearing\s+House/gi,
                /Social\s+Security/gi,
                /Internal\s+Revenue/gi,
                /Bank\s+of\s+America/gi,
                /Microsoft/gi,
                /Google/gi,
                /Amazon/gi,
                /PayPal/gi,
                /Walmart/gi,
                /lottery/gi,
                /sweepstakes/gi,
                /prize/gi,
                /winner/gi,
                /million/gi
            ];
            
            suspiciousPatterns.forEach(pattern => {
                const matches = data.match(pattern);
                if (matches) {
                    words.push(...matches.map(m => m.trim()));
                }
            });
        }
        
        // Remove duplicates and normalize
        words = [...new Set(words.map(word => word.toLowerCase().trim()))];
        
        logger.debug(`Extracted ${words.length} blocked words from source`);
        logger.debug(`Sample words: ${words.slice(0, 10).join(', ')}`);
        
        if (words.length === 0) {
            logger.warn('No valid blocked words found in response');
            return; // Don't clear existing word blocklist if we can't parse new data
        }
        
        // Add words to blocklist
        let validCount = 0;
        words.forEach(word => {
            if (word && word.length >= 2) {
                wordBlocklist.add(word.toLowerCase());
                // Also add variations without special characters
                const cleanWord = word.replace(/[^a-zA-Z0-9\s]/g, '').toLowerCase();
                if (cleanWord.length >= 2) {
                    wordBlocklist.add(cleanWord);
                }
                validCount++;
            }
        });
        
        logger.info(`Successfully loaded ${validCount} blocked words (${wordBlocklist.size} total variations)`);
        wordBlocklistLastUpdated = new Date().toISOString();
        
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to download blocked words');
        // Don't throw error - let server continue without word blocklist
    }
}

// Function to refresh blocklist periodically
function setupBlocklistRefresh() {
    // Initial download
    downloadBlocklist();
    downloadWordBlocklist();
    
    // Refresh every 6 hours
    setInterval(() => {
        logger.info('Refreshing blocklists...');
        downloadBlocklist();
        downloadWordBlocklist();
    }, 6 * 60 * 60 * 1000);
}

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
                    'User-Agent': 'TrueSIP-API/1.9.1',
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
                    'User-Agent': 'TrueSIP-API/1.9.1',
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
                    'User-Agent': 'TrueSIP-API/1.9.1',
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

// =============================================================================
// === CORRECTED ENABLEX CLIENT ================================================
// =============================================================================
class EnableXClient {
    constructor() {
        this.appId = process.env.ENABLEX_APP_ID;
        this.appKey = process.env.ENABLEX_APP_KEY;
        this.baseUrl = 'https://api.enablex.io/voice/v1';
        this.activeCalls = new Map();
    }

    /**
     * Generates the correct Basic Authentication header for EnableX.
     * @returns {string} The Basic Auth header value.
     */
    getAuthHeader() {
        if (!this.appId || !this.appKey) {
            throw new Error('EnableX App ID or App Key is missing from environment variables.');
        }
        // Encode 'APP_ID:APP_KEY' to Base64
        const credentials = Buffer.from(`${this.appId}:${this.appKey}`).toString('base64');
        return `Basic ${credentials}`;
    }

    async makeCall(to, from, audioContent, options = {}) {
        try {
            logger.info({ to, from, provider: 'EnableX' }, 'Initiating EnableX call');

            const authHeader = this.getAuthHeader();
            
            // --- CONSTRUCT THE CORRECT ENABLEX PAYLOAD ---
            let callData = {
                name: "SESPCL API Call",
                from: from,
                to: to, // EnableX expects a simple string for the 'to' number
                event_url: process.env.ENABLEX_WEBHOOK_URL || 'https://your-app.com/webhook/enablex'
            };

            // Define the action to take when the call connects
            if (options.isText) {
                callData.action_on_connect = {
                    play: {
                        text: audioContent,
                        voice: options.voice || "female", // Example voices: female, male
                        language: options.language || "en-US",
                        prompt_ref: "tts-prompt-from-server"
                    }
                };
            } else { // Assumes audioContent is an audioUrl
                callData.action_on_connect = {
                    play: {
                        file_url: [audioContent] // file_url should be an array of strings
                    }
                };
            }

            // NOTE: EnableX handles IVR (transfers) via webhooks and subsequent API calls.
            // The logic for 'transferToNumber' and 'dtmfTransferDigit' must be handled 
            // in your webhook endpoint by making a new API call to modify the live call.
            // It cannot be done in this initial API request.

            const response = await axios.post(
                `${this.baseUrl}/call`, // Correct endpoint
                callData,
                {
                    headers: {
                        'Authorization': authHeader, // Use Basic Auth
                        'Content-Type': 'application/json'
                    },
                    timeout: 15000
                }
            );
            
            // The call identifier from EnableX is 'voice_id'
            const callId = response.data.voice_id || 'unknown-enablex-id';
            
            this.activeCalls.set(callId, { to, from, status: 'INITIATED' });

            logger.info({ callId, to }, 'EnableX call initiated successfully');

            return {
                success: true,
                callId: callId,
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
            const statusCode = error.response ? error.response.status : 500;
            const errorDetails = error.response ? error.response.data : error.message;
            logger.error({ error: errorDetails, statusCode, provider: 'EnableX' }, 'EnableX call failed');
            // Ensure a consistent error object is thrown
            const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
            throw new Error(`EnableX call failed: ${errorMessage}`);
        }
    }

    // You would also need to implement getCallStatus, hangupCall, etc.
    // using the same Basic Authentication method.
    async getCallStatus(callId) {
       try {
           const authHeader = this.getAuthHeader();
           const response = await axios.get(`${this.baseUrl}/call/${callId}`, {
               headers: { 'Authorization': authHeader },
               timeout: 5000
           });
           return response.data;
       } catch (error) {
           logger.error({ error: error.message }, `Failed to get EnableX call status for ${callId}`);
           return { error: 'Call not found or error retrieving status' };
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

// Initialize blocklist system
setupBlocklistRefresh();

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

// Function to check if text contains blocked words
function containsBlockedWords(text) {
    if (!text || wordBlocklist.size === 0) return null;
    
    const textLower = text.toLowerCase();
    
    // Check for blocked words/phrases with more precise matching
    for (const blockedWord of wordBlocklist) {
        const wordLower = blockedWord.toLowerCase();
        
        // For single short words (2-3 chars), require word boundaries
        if (wordLower.length <= 3 && !wordLower.includes(' ')) {
            const wordBoundaryRegex = new RegExp(`\\b${wordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (wordBoundaryRegex.test(textLower)) {
                // Additional check for very common words to avoid false positives
                if (wordLower === 'us' || wordLower === 'is' || wordLower === 'as' || wordLower === 'on' || wordLower === 'to') {
                    // For these common words, require they're not part of legitimate business context
                    const context = textLower.replace(wordBoundaryRegex, '').trim();
                    if (context.length < 10) { // Very short text, might be suspicious
                        return blockedWord;
                    }
                    continue; // Skip matching these common words in longer legitimate text
                }
                return blockedWord;
            }
        } else {
            // For longer words/phrases, use simple includes matching
            if (textLower.includes(wordLower)) {
                return blockedWord;
            }
        }
    }
    
    return null;
}

// --- Blocklist Check Middleware ---
const blocklistCheck = (req, res, next) => {
    // Only check blocklist for call endpoints
    if (req.path.includes('/call/') && req.method === 'POST') {
        const toNumber = req.body.to;
        const textContent = req.body.text;
        
        // Check blocked numbers
        if (toNumber && blocklist.has(toNumber)) {
            req.log.warn({ to: toNumber, ip: req.ip }, 'Blocked number call attempt');
            return res.status(403).json({ 
                error: 'Call blocked', 
                details: 'This number is on the security blocklist and cannot be called.',
                blocked: true,
                reason: 'blocked_number'
            });
        }
        
        // Check blocked words in text content
        if (textContent) {
            const blockedWord = containsBlockedWords(textContent);
            if (blockedWord) {
                req.log.warn({ 
                    to: toNumber, 
                    ip: req.ip, 
                    blockedWord: blockedWord,
                    textLength: textContent.length 
                }, 'Blocked word in call content');
                return res.status(403).json({ 
                    error: 'Call blocked', 
                    details: 'The message content contains blocked words/phrases and cannot be sent.',
                    blocked: true,
                    reason: 'blocked_content'
                });
            }
        }
    }
    next();
};

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

    // STEP 1: Google API Content Analysis (Perspective API for spam detection)
    if (messageContent) {
        const analysisResult = await analyzeContent(messageContent, req.log);
        if (!analysisResult.passed) {
            return res.status(400).json({ 
                error: 'Content validation failed', 
                details: analysisResult.error 
            });
        }
    }
    
    // STEP 2: Blocklist checks (now performed AFTER Google API check)
    const toNumber = req.body.to;
    const textContent = messageContent || req.body.text;
    
    // Check blocked numbers
    if (toNumber && blocklist.has(toNumber)) {
        req.log.warn({ to: toNumber, ip: req.ip }, 'Blocked number call attempt');
        return res.status(403).json({ 
            error: 'Call blocked', 
            details: 'This number is on the security blocklist and cannot be called.',
            blocked: true,
            reason: 'blocked_number'
        });
    }
    
    // Check blocked words in text content
    if (textContent) {
        const blockedWord = containsBlockedWords(textContent);
        if (blockedWord) {
            req.log.warn({ 
                to: toNumber, 
                ip: req.ip, 
                blockedWord: blockedWord,
                textLength: textContent.length 
            }, 'Blocked word in call content');
            return res.status(403).json({ 
                error: 'Call blocked', 
                details: 'The message content contains blocked words/phrases and cannot be sent.',
                blocked: true,
                reason: 'blocked_content'
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
                voice: req.body.voice || 'female', // Pass voice from request or default
                language: req.body.language || 'en-US', // Pass language from request or default
                // IVR options for providers that support it in the initial call
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
 * @route   GET /api/v1/blocklist/status
 * @desc    Get blocklist status and statistics
 * @access  Private (Requires API Key)
 */
app.get('/api/v1/blocklist/status', apiKeyAuth, (req, res) => {
    res.status(200).json({
        numberBlocklist: {
            enabled: true,
            totalNumbers: blocklist.size,
            source: 'https://dial.truesip.net/blocklist-numbers/',
            lastUpdated: blocklistLastUpdated,
            refreshInterval: '6 hours',
            nextRefresh: blocklistLastUpdated ? new Date(new Date(blocklistLastUpdated).getTime() + 6 * 60 * 60 * 1000).toISOString() : null
        },
        wordBlocklist: {
            enabled: true,
            totalWords: wordBlocklist.size,
            source: 'https://dial.truesip.net/blocklist-words/',
            lastUpdated: wordBlocklistLastUpdated,
            refreshInterval: '6 hours',
            nextRefresh: wordBlocklistLastUpdated ? new Date(new Date(wordBlocklistLastUpdated).getTime() + 6 * 60 * 60 * 1000).toISOString() : null
        }
    });
});

/**
 * @route   POST /api/v1/blocklist/refresh
 * @desc    Manually refresh both number and word blocklists
 * @access  Private (Requires API Key)
 */
app.post('/api/v1/blocklist/refresh', apiKeyAuth, async (req, res) => {
    try {
        const numberSizeBefore = blocklist.size;
        const wordSizeBefore = wordBlocklist.size;
        
        await Promise.all([
            downloadBlocklist(),
            downloadWordBlocklist()
        ]);
        
        const numberSizeAfter = blocklist.size;
        const wordSizeAfter = wordBlocklist.size;
        
        res.status(200).json({
            message: 'Blocklists refreshed successfully',
            numbers: {
                sizeBefore: numberSizeBefore,
                sizeAfter: numberSizeAfter
            },
            words: {
                sizeBefore: wordSizeBefore,
                sizeAfter: wordSizeAfter
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to refresh blocklists',
            details: error.message
        });
    }
});

/**
 * @route   POST /api/v1/blocklist/check
 * @desc    Check if a number or text contains blocked content
 * @access  Private (Requires API Key)
 */
app.post('/api/v1/blocklist/check', apiKeyAuth, (req, res) => {
    const { number, text } = req.body;
    
    if (!number && !text) {
        return res.status(400).json({
            error: 'Missing number or text parameter'
        });
    }
    
    const result = {
        timestamp: new Date().toISOString()
    };
    
    // Check number if provided
    if (number) {
        result.number = {
            value: number,
            blocked: blocklist.has(number)
        };
    }
    
    // Check text if provided
    if (text) {
        const blockedWord = containsBlockedWords(text);
        result.text = {
            value: text,
            blocked: !!blockedWord,
            blockedWord: blockedWord || null
        };
    }
    
    res.status(200).json(result);
});

/**
 * @route   GET /api/v1/blocklist/words/status
 * @desc    Get word blocklist status and sample words
 * @access  Private (Requires API Key)
 */
app.get('/api/v1/blocklist/words/status', apiKeyAuth, (req, res) => {
    const sampleWords = Array.from(wordBlocklist).slice(0, 20); // Show first 20 words as sample
    
    res.status(200).json({
        wordBlocklist: {
            enabled: true,
            totalWords: wordBlocklist.size,
            source: 'https://dial.truesip.net/blocklist-words/',
            lastUpdated: wordBlocklistLastUpdated,
            refreshInterval: '6 hours',
            nextRefresh: wordBlocklistLastUpdated ? new Date(new Date(wordBlocklistLastUpdated).getTime() + 6 * 60 * 60 * 1000).toISOString() : null,
            sampleWords: sampleWords
        }
    });
});

/**
 * @route   POST /api/v1/blocklist/words/refresh
 * @desc    Manually refresh word blocklist only
 * @access  Private (Requires API Key)
 */
app.post('/api/v1/blocklist/words/refresh', apiKeyAuth, async (req, res) => {
    try {
        const sizeBefore = wordBlocklist.size;
        await downloadWordBlocklist();
        const sizeAfter = wordBlocklist.size;
        
        res.status(200).json({
            message: 'Word blocklist refreshed successfully',
            sizeBefore,
            sizeAfter,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to refresh word blocklist',
            details: error.message
        });
    }
});

/**
 * @route   POST /api/v1/blocklist/words/check
 * @desc    Check if text contains blocked words (text-only version)
 * @access  Private (Requires API Key)
 */
app.post('/api/v1/blocklist/words/check', apiKeyAuth, (req, res) => {
    const { text } = req.body;
    
    if (!text) {
        return res.status(400).json({
            error: 'Missing text parameter'
        });
    }
    
    const blockedWord = containsBlockedWords(text);
    
    res.status(200).json({
        text: text,
        blocked: !!blockedWord,
        blockedWord: blockedWord || null,
        timestamp: new Date().toISOString()
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
        version: '1.9.1-optimized',
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
        },
        blocklist: {
            numbers: {
                enabled: true,
                total: blocklist.size,
                lastUpdated: blocklistLastUpdated
            },
            words: {
                enabled: true,
                total: wordBlocklist.size,
                lastUpdated: wordBlocklistLastUpdated
            },
            source: 'dial.truesip.net'
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
        version: '1.9.1-optimized'
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
