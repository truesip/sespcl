# TrueSIP Blocklist Implementation

## Overview
We've successfully integrated a comprehensive dual-blocklist system that fetches:
1. **Blocked phone numbers** from `https://dial.truesip.net/blocklist-numbers/`
2. **Blocked words/phrases** from `https://dial.truesip.net/blocklist-words/`

This provides multi-layered protection as the first line of defense for your Voice API server.

## 🛡️ Features Implemented

### 1. **Auto-Updating Dual Blocklists**
**Number Blocklist:**
- Fetches blocked numbers from TrueSIP on server startup
- Automatically refreshes every 6 hours
- Handles HTML parsing to extract phone numbers
- Stores multiple format variations (+1, +, clean numbers)

**Word Blocklist:**
- Fetches 659+ blocked words/phrases from TrueSIP
- Scans for scam-related content (lottery, sweepstakes, government agencies, etc.)
- Intelligent parsing of comma-separated word lists
- Smart matching to avoid false positives

### 2. **Smart Blocking Middleware**
- Only applies to call endpoints (`/api/v1/call/*`)
- **Number blocking**: Returns 403 for blocked phone numbers
- **Content blocking**: Scans message text for blocked words/phrases
- Returns specific error reasons (`blocked_number` or `blocked_content`)
- Logs all blocked attempts with details for monitoring

### 3. **Management Endpoints**
**Combined Endpoints:**
```
GET /api/v1/blocklist/status    # View both blocklist statistics
POST /api/v1/blocklist/refresh  # Manually refresh both blocklists
POST /api/v1/blocklist/check    # Check number and/or text
```

**Word-Specific Endpoints:**
```
GET /api/v1/blocklist/words/status    # Word blocklist details + samples
POST /api/v1/blocklist/words/refresh  # Refresh word blocklist only
POST /api/v1/blocklist/words/check    # Check text for blocked words
```

### 4. **Health Monitoring**
- Blocklist status included in `/health` endpoint
- Tracks total numbers, last update time
- Shows next refresh schedule

## 🔧 Implementation Details

### Blocklist Loading
- Parses HTML response from TrueSIP
- Extracts phone numbers using regex patterns
- Handles comma-separated and other formats
- Validates number formats (10-15 digits)

### Number Format Handling
For each blocked number, stores multiple variations:
- Original format: `18009359935`
- Clean format: `8009359935` 
- Plus format: `+8009359935`
- US format: `+18009359935`

### Error Handling
- Graceful fallback if blocklist fetch fails
- Server continues without blocklist if needed
- Detailed logging for troubleshooting

## 📊 Test Results

✅ **Number Blocklist**: 108 blocked numbers loaded from TrueSIP  
✅ **Word Blocklist**: 659 blocked words/phrases loaded from TrueSIP  
✅ **Number Blocking**: Blocked numbers return 403 Forbidden  
✅ **Content Blocking**: Messages with blocked words return 403 Forbidden  
✅ **False Positive Prevention**: Smart matching avoids blocking legitimate content  
✅ **Allow Works**: Clean numbers and content proceed normally  
✅ **API Endpoints**: All management endpoints working  
✅ **Auto-Refresh**: 6-hour refresh cycle for both blocklists  

## 🚀 Usage

### Blocked Number Call
```bash
curl -X POST http://localhost:3000/api/v1/call/tts \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"to":"18009359935","text":"Test message"}'

# Response: 403 Forbidden
# {"error":"Call blocked","details":"This number is on the security blocklist...","reason":"blocked_number"}
```

### Blocked Content Call
```bash
curl -X POST http://localhost:3000/api/v1/call/tts \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"to":"+15551234567","text":"You won a Publishers Clearing House prize!"}'

# Response: 403 Forbidden
# {"error":"Call blocked","details":"The message content contains blocked words...","reason":"blocked_content"}
```

### Check Blocklist Status
```bash
curl -X GET http://localhost:3000/api/v1/blocklist/status \
  -H "x-api-key: your-api-key"
```

### Check Number and Text
```bash
curl -X POST http://localhost:3000/api/v1/blocklist/check \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"number":"18009359935","text":"You won a lottery prize!"}'
```

### Check Text Only
```bash
curl -X POST http://localhost:3000/api/v1/blocklist/words/check \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"text":"Social Security Administration needs verification"}'
```

## 🔧 Configuration

No additional environment variables needed - the blocklist works out of the box with your existing setup.

Optional: You can modify the refresh interval in `server.js` (currently 6 hours).

## 📈 Benefits

1. **Dual Protection**: Blocks both bad numbers AND suspicious content
2. **Scam Prevention**: Detects lottery, sweepstakes, government impersonation scams
3. **Performance**: Fast in-memory lookup using Set data structures
4. **Smart Matching**: Avoids false positives with intelligent word boundaries
5. **Reliability**: Auto-updating ensures fresh blocklist data
6. **Monitoring**: Full visibility into both blocklist statuses and blocks
7. **Maintenance**: Zero-config auto-management

## 🎯 Next Steps

The blocklist is now live and protecting your Voice API server. Consider:

1. **Monitoring**: Watch blocked call logs for patterns
2. **Alerts**: Set up notifications for high block rates
3. **Custom Lists**: Add capability for custom blocklist entries
4. **Reporting**: Track blocked vs allowed call ratios

---

**Implementation Status**: ✅ Complete and Tested  
**Security Enhancement**: Dual-layer first line of defense active  
**Number Blocklist**: 108 blocked numbers from TrueSIP  
**Word Blocklist**: 659 blocked words/phrases from TrueSIP  
**Maintenance**: Zero-touch auto-updating every 6 hours  
