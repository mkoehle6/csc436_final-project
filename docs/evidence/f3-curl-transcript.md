# F3: REST API, `curl -i` per route (including failures)

Local run of the compiled backend (commit 08f9a17) with synthetic users and a throwaway
signing key; token values are redacted in the commands shown. Generated 2026-11-23T02:01:59Z.
Error responses always use one shape: `{"error":{"code","message","details"?}}`.

### Health: 200
```
$ curl -i -X GET http://localhost:3997/healthz
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=utf-8

{"status":"ok","checks":{"database":"ok"},"commit":null,"startedAt":"2026-11-23T02:01:35.358Z","timestamp":"2026-11-23T02:01:59.803Z"}
```

### Questions: 200 (public, no answers, never cached)
```
$ curl -i -X GET http://localhost:3997/api/questions?count=2
HTTP/1.1 200 OK
RateLimit-Limit: 30
RateLimit-Remaining: 29
Cache-Control: no-store
Content-Type: application/json; charset=utf-8

{"questions":[{"id":3,"prompt":"Evidence question 2?","category":"character","choices":["Right","W1","W2","W3"],"imagePath":null},{"id":27,"prompt":"Evidence question 26?","category":"character","choices":["Right","W1","W2","W3"],"imagePath":null}],"degraded":false}
```

### Questions: 400 invalid query
```
$ curl -i -X GET http://localhost:3997/api/questions?count=0
HTTP/1.1 400 Bad Request
RateLimit-Limit: 30
RateLimit-Remaining: 28
Content-Type: application/json; charset=utf-8

{"error":{"code":"VALIDATION_ERROR","message":"Invalid query parameters","details":{"formErrors":[],"fieldErrors":{"count":["Too small: expected number to be >=1"]}}}}
```

### One question: 200
```
$ curl -i -X GET http://localhost:3997/api/questions/1
HTTP/1.1 200 OK
RateLimit-Limit: 120
RateLimit-Remaining: 117
Content-Type: application/json; charset=utf-8

{"id":1,"prompt":"Evidence question 0?","category":"character","choices":["Right","W1","W2","W3"],"imagePath":null}
```

### One question: 404
```
$ curl -i -X GET http://localhost:3997/api/questions/99999
HTTP/1.1 404 Not Found
RateLimit-Limit: 120
RateLimit-Remaining: 116
Content-Type: application/json; charset=utf-8

{"error":{"code":"NOT_FOUND","message":"Question not found"}}
```

### One question: 400 bad id
```
$ curl -i -X GET http://localhost:3997/api/questions/abc
HTTP/1.1 400 Bad Request
RateLimit-Limit: 120
RateLimit-Remaining: 115
Content-Type: application/json; charset=utf-8

{"error":{"code":"VALIDATION_ERROR","message":"id must be a positive integer"}}
```

### Check answer (anonymous): 200
```
$ curl -i -X POST http://localhost:3997/api/questions/1/check -H 'Content-Type: application/json' -d '{"selectedAnswer":"Right"}'
HTTP/1.1 200 OK
RateLimit-Limit: 120
RateLimit-Remaining: 114
Content-Type: application/json; charset=utf-8

{"questionId":1,"selectedAnswer":"Right","isCorrect":true,"correctAnswer":"Right"}
```

### Check answer: 400 missing field
```
$ curl -i -X POST http://localhost:3997/api/questions/1/check -H 'Content-Type: application/json' -d '{}'
HTTP/1.1 400 Bad Request
RateLimit-Limit: 120
RateLimit-Remaining: 113
Content-Type: application/json; charset=utf-8

{"error":{"code":"VALIDATION_ERROR","message":"Invalid answer payload","details":{"formErrors":[],"fieldErrors":{"selectedAnswer":["Invalid input: expected string, received undefined"]}}}}
```

### Create question, no token: 401
```
$ curl -i -X POST http://localhost:3997/api/questions -H 'Content-Type: application/json' -d '{"prompt":"Who runs the Kwik-E-Mart?","category":"character","correctAnswer":"Apu","choices":["Apu","Moe","Ned","Otto"],"sourceEntityId":1}'
HTTP/1.1 401 Unauthorized
RateLimit-Limit: 120
RateLimit-Remaining: 112
Content-Type: application/json; charset=utf-8

{"error":{"code":"UNAUTHORIZED","message":"Authentication required"}}
```

### Create question as viewer: 403
```
$ curl -i -X POST http://localhost:3997/api/questions -H "Authorization: Bearer <viewer token>" -H 'Content-Type: application/json' -d '{"prompt":"Who runs the Kwik-E-Mart?","category":"character","correctAnswer":"Apu","choices":["Apu","Moe","Ned","Otto"],"sourceEntityId":1}'
HTTP/1.1 403 Forbidden
RateLimit-Limit: 120
RateLimit-Remaining: 111
Content-Type: application/json; charset=utf-8

{"error":{"code":"FORBIDDEN","message":"Insufficient permissions"}}
```

### Create question as operator: 400 invalid body
```
$ curl -i -X POST http://localhost:3997/api/questions -H "Authorization: Bearer <operator token>" -H 'Content-Type: application/json' -d '{"prompt":"","category":"nope"}'
HTTP/1.1 400 Bad Request
RateLimit-Limit: 30
RateLimit-Remaining: 29
Content-Type: application/json; charset=utf-8

{"error":{"code":"VALIDATION_ERROR","message":"Invalid question payload","details":{"formErrors":[],"fieldErrors":{"prompt":["Too small: expected string to have >=1 characters"],"category":["Invalid option: expected one of \"character\"|\"episode\"|\"location\""],"correctAnswer":["Invalid input: expected string, received undefined"],"choices":["Invalid input: expected array, received undefined"],"…
```

### Create question as operator: 201 + Location
```
$ curl -i -X POST http://localhost:3997/api/questions -H "Authorization: Bearer <operator token>" -H 'Content-Type: application/json' -d '{"prompt":"Who runs the Kwik-E-Mart?","category":"character","correctAnswer":"Apu","choices":["Apu","Moe","Ned","Otto"],"sourceEntityId":1}'
HTTP/1.1 201 Created
RateLimit-Limit: 30
RateLimit-Remaining: 28
Location: /api/questions/61
Content-Type: application/json; charset=utf-8

{"id":61,"prompt":"Who runs the Kwik-E-Mart?","category":"character","correctAnswer":"Apu","choices":["Apu","Moe","Ned","Otto"],"imagePath":null,"sourceEntityId":1,"createdAt":"2026-11-23T02:02:00.983Z"}
```

### Create the same question again: 409
```
$ curl -i -X POST http://localhost:3997/api/questions -H "Authorization: Bearer <operator token>" -H 'Content-Type: application/json' -d '{"prompt":"Who runs the Kwik-E-Mart?","category":"character","correctAnswer":"Apu","choices":["Apu","Moe","Ned","Otto"],"sourceEntityId":1}'
HTTP/1.1 409 Conflict
RateLimit-Limit: 30
RateLimit-Remaining: 27
Content-Type: application/json; charset=utf-8

{"error":{"code":"CONFLICT","message":"A question with this prompt already exists in this category"}}
```

### Delete question as operator: 204
```
$ curl -i -X DELETE http://localhost:3997/api/questions/61 -H "Authorization: Bearer <operator token>"
HTTP/1.1 204 No Content
RateLimit-Limit: 30
RateLimit-Remaining: 26


```

### Delete it again: 404
```
$ curl -i -X DELETE http://localhost:3997/api/questions/61 -H "Authorization: Bearer <operator token>"
HTTP/1.1 404 Not Found
RateLimit-Limit: 30
RateLimit-Remaining: 25
Content-Type: application/json; charset=utf-8

{"error":{"code":"NOT_FOUND","message":"Question not found"}}
```

### Start game session as viewer: 201 + Location
```
$ curl -i -X POST http://localhost:3997/api/sessions -H "Authorization: Bearer <viewer token>"
HTTP/1.1 201 Created
RateLimit-Limit: 30
RateLimit-Remaining: 29
Location: /api/sessions/1
Content-Type: application/json; charset=utf-8

{"id":1,"userId":1,"startedAt":"2026-11-23T02:02:01.589Z","completedAt":null,"score":0}
```

### Answer in own session: 201 + Location (server-scored)

_Session 2 was started by a second `POST /api/sessions` (same as above, not repeated here); the answer is scored on the server and the choice of `"Right"` is the seeded correct answer for question 1._
```
$ curl -i -X POST http://localhost:3997/api/sessions/2/answers -H "Authorization: Bearer <viewer token>" -H 'Content-Type: application/json' -d '{"questionId":1,"selectedAnswer":"Right"}'
HTTP/1.1 201 Created
RateLimit-Limit: 30
RateLimit-Remaining: 27
Location: /api/sessions/2
Content-Type: application/json; charset=utf-8

{"answer":{"id":1,"sessionId":2,"questionId":1,"selectedAnswer":"Right","isCorrect":true,"answeredAt":"2026-11-23T02:02:01.834Z"},"score":{"correctCount":1,"totalCount":1,"percentage":100,"points":10},"eventId":1,"isCorrect":true,"correctAnswer":"Right"}
```

### Answer the same question again: 409
```
$ curl -i -X POST http://localhost:3997/api/sessions/2/answers -H "Authorization: Bearer <viewer token>" -H 'Content-Type: application/json' -d '{"questionId":1,"selectedAnswer":"W1"}'
HTTP/1.1 409 Conflict
RateLimit-Limit: 30
RateLimit-Remaining: 26
Content-Type: application/json; charset=utf-8

{"error":{"code":"CONFLICT","message":"This question was already answered in this session"}}
```

### Delete a question that has answers: 409
```
$ curl -i -X DELETE http://localhost:3997/api/questions/1 -H "Authorization: Bearer <operator token>"
HTTP/1.1 409 Conflict
RateLimit-Limit: 30
RateLimit-Remaining: 24
Content-Type: application/json; charset=utf-8

{"error":{"code":"CONFLICT","message":"Question has recorded answers and cannot be deleted"}}
```

### Session score: 200
```
$ curl -i -X GET http://localhost:3997/api/sessions/2 -H "Authorization: Bearer <viewer token>"
HTTP/1.1 200 OK
RateLimit-Limit: 120
RateLimit-Remaining: 99
Content-Type: application/json; charset=utf-8

{"session":{"id":2,"userId":1,"startedAt":"2026-11-23T02:02:01.743Z","completedAt":null,"score":10},"score":{"correctCount":1,"totalCount":1,"percentage":100,"points":10}}
```

### Someone else's session: 404 (not 403, so ids cannot be probed)
```
$ curl -i -X GET http://localhost:3997/api/sessions/2 -H "Authorization: Bearer <operator token>"
HTTP/1.1 404 Not Found
RateLimit-Limit: 120
RateLimit-Remaining: 98
Content-Type: application/json; charset=utf-8

{"error":{"code":"NOT_FOUND","message":"Session not found"}}
```

### Leaderboard: 200 (briefly cacheable)
```
$ curl -i -X GET http://localhost:3997/api/leaderboard
HTTP/1.1 200 OK
RateLimit-Limit: 120
RateLimit-Remaining: 97
Cache-Control: public, max-age=5, s-maxage=10
Content-Type: application/json; charset=utf-8

{"leaderboard":[{"rank":1,"player":"Sleepy Comet #1","points":10,"sessions":2}],"lastEventId":1}
```

### Malformed JSON body: 400
```
$ curl -i -X POST http://localhost:3997/api/questions/1/check -H 'Content-Type: application/json' -d '{bad json'
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8

{"error":{"code":"VALIDATION_ERROR","message":"Request body is not valid JSON"}}
```

### Unknown route: 404
```
$ curl -i -X GET http://localhost:3997/api/nope
HTTP/1.1 404 Not Found
RateLimit-Limit: 120
RateLimit-Remaining: 96
Content-Type: application/json; charset=utf-8

{"error":{"code":"NOT_FOUND","message":"No route for GET /api/nope"}}
```

### MCP without a token: 401 + resource_metadata challenge
```
$ curl -i -X POST http://localhost:3997/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="http://localhost:3997/.well-known/oauth-protected-resource/mcp"
Content-Type: application/json; charset=utf-8

{"error":"invalid_token","error_description":"Missing Authorization header"}
```

