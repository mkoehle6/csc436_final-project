# F3: staging, public and unauthenticated routes

Run against https://trivia-staging-api.burnscodev.com from outside (staging backend commit 08f9a17). Generated 2026-11-23T02:04:51Z.
Signed-in routes (201/204/403/409) are in `f3-curl-transcript.md` (local run with synthetic users), because real staging tokens must not appear in evidence.

### Health: 200
```
$ curl -i -X GET https://trivia-staging-api.burnscodev.com/healthz
HTTP/1.1 200 OK

{"status":"ok","checks":{"database":"ok"},"commit":"08f9a17392899f3df50d122df581d394c829a4b4","startedAt":"2026-11-23T02:04:48.497Z","timestamp":"2026-11-23T02:04:52.171Z"}
```

### Questions: 200
```
$ curl -i -X GET https://trivia-staging-api.burnscodev.com/api/questions?count=2
HTTP/1.1 200 OK
ratelimit-limit: 30
ratelimit-remaining: 29

{"questions":[{"id":43,"prompt":"What is Horst's occupation?","category":"character","choices":["Samba School teacher","High lama","Inventor","Businessman"],"imagePath":"https://cdn.thesimpsonsapi.com/500/character/348.webp"},{"id":34,"prompt":"What is Üter Zörker's occupation?","category":"character","choices":["Former U.S. President","Student at Springfield Elementary School","Chairman of I&S …
```

### Questions: 400 invalid query
```
$ curl -i -X GET https://trivia-staging-api.burnscodev.com/api/questions?count=0
HTTP/1.1 400 Bad Request
ratelimit-limit: 30
ratelimit-remaining: 29

{"error":{"code":"VALIDATION_ERROR","message":"Invalid query parameters","details":{"formErrors":[],"fieldErrors":{"count":["Too small: expected number to be >=1"]}}}}
```

### One question: 404
```
$ curl -i -X GET https://trivia-staging-api.burnscodev.com/api/questions/99999999
HTTP/1.1 404 Not Found
ratelimit-limit: 120
ratelimit-remaining: 118

{"error":{"code":"NOT_FOUND","message":"Question not found"}}
```

### Check answer: 400 missing field
```
$ curl -i -X POST https://trivia-staging-api.burnscodev.com/api/questions/1/check -H 'Content-Type: application/json' -d '{}'
HTTP/1.1 400 Bad Request
ratelimit-limit: 120
ratelimit-remaining: 118

{"error":{"code":"VALIDATION_ERROR","message":"Invalid answer payload","details":{"formErrors":[],"fieldErrors":{"selectedAnswer":["Invalid input: expected string, received undefined"]}}}}
```

### Create question, no token: 401
```
$ curl -i -X POST https://trivia-staging-api.burnscodev.com/api/questions -H 'Content-Type: application/json' -d '{"prompt":"x","category":"character","correctAnswer":"a","choices":["a","b","c","d"]}'
HTTP/1.1 401 Unauthorized
ratelimit-limit: 120
ratelimit-remaining: 117

{"error":{"code":"UNAUTHORIZED","message":"Authentication required"}}
```

### Start session, no token: 401
```
$ curl -i -X POST https://trivia-staging-api.burnscodev.com/api/sessions
HTTP/1.1 401 Unauthorized
ratelimit-limit: 120
ratelimit-remaining: 116

{"error":{"code":"UNAUTHORIZED","message":"Authentication required"}}
```

### Leaderboard: 200
```
$ curl -i -X GET https://trivia-staging-api.burnscodev.com/api/leaderboard
HTTP/1.1 200 OK
ratelimit-limit: 120
ratelimit-remaining: 115

{"leaderboard":[{"rank":1,"player":"Sleepy Comet #1","points":80,"sessions":3}],"lastEventId":10}
```

### Malformed JSON: 400
```
$ curl -i -X POST https://trivia-staging-api.burnscodev.com/api/questions/1/check -H 'Content-Type: application/json' -d '{bad json'
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Request body is not valid JSON"}}
```

### Unknown route: 404
```
$ curl -i -X GET https://trivia-staging-api.burnscodev.com/api/nope
HTTP/1.1 404 Not Found
ratelimit-limit: 120
ratelimit-remaining: 117

{"error":{"code":"NOT_FOUND","message":"No route for GET /api/nope"}}
```

### MCP without a token: 401 + resource_metadata challenge
```
$ curl -i -X POST https://trivia-staging-api.burnscodev.com/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -H 'Accept: application/json, text/event-stream'
HTTP/1.1 401 Unauthorized
access-control-allow-origin: *
www-authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="https://trivia-staging-api.burnscodev.com/.well-known/oauth-protected-resource/mcp"

{"error":"invalid_token","error_description":"Missing Authorization header"}
```

### CORS preflight from the staging frontend: 204
```
$ curl -i -X OPTIONS https://trivia-staging-api.burnscodev.com/api/questions -H 'Origin: https://trivia-staging.burnscodev.com' -H 'Access-Control-Request-Method: POST'
HTTP/1.1 204 No Content
access-control-allow-origin: https://trivia-staging.burnscodev.com


```

### CORS preflight from another origin: refused
```
$ curl -i -X OPTIONS https://trivia-staging-api.burnscodev.com/api/questions -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST'
HTTP/1.1 403 Forbidden


```

