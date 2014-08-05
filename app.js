var express = require('express')
  , app = express()
  , http = require('http')
  , server = http.createServer(app)
  , io = require('socket.io').listen(server)
  , bodyParser = require('body-parser')
  , fdb = require('fdb').apiVersion(200)
  , id = 0

// HELPERS --------------------------

function sanitize_for_json(string) {
  string = string ? string : ''
  string = string.replace(/\"/g, '\\"')
  string = string.replace(/\s/g, ' ')
  return string.replace(/\\/g, '\\\\')
}


// LOADING FROM DB --------------------------

function load_chats(callback, since) {
  fdb.directory.createOrOpen(db, 'events').then(function(events) {
    db.doTransaction(function(tr) {
      var range = events.range()
      var start
      if (since) {
        start = events.pack([since + 1])
      } else {
        start = range.begin
      }
      var iterator = tr.getRange(start, range.end)
      iterator.toArray(function(err, chats) {
        var new_chats = []
        for (chat in chats) {
          var chat_json = chats[chat].value.toString()
          new_chats.push(JSON.parse(chat_json))
          id = events.unpack(chats[chat].key)[0]
        }
        callback(new_chats)
      })
    })
  })
}

function load_users(callback) {
  fdb.directory.createOrOpen(db, 'users').then(function(users) {
    var range = users.range()
    db.getRange(range.begin, range.end, {}, function(err, users) {
      var user_list = []
      for (user in users) {
        var name = users[user].value.toString()
        user_list.push(name)
      }
      callback(user_list)
    })
  });
}

function load_all(callback, since) {
  var data = {}
  load_chats(function(chats) {
    data.chats = chats
    load_users(function(users) {
      data.users = users
      callback(data)
    })
  }, since)
}


// SAVING TO DB --------------------------

function save_event(json) {
  fdb.directory.createOrOpen(db, 'events').then(function(events) {
    db.doTransaction(function(tr, commit) {
      var range = events.range()
      var iterator = tr.getRange(range.begin, range.end, { reverse: true, limit: 1 })
      iterator.toArray(function(err, chats) {
        var most_recent = chats[0]
        if (most_recent) {
          var new_id = events.unpack(most_recent.key)[0] + 1
        } else {
          var new_id = id + 1
        }

        console.log(fdb.buffer.printable(events.pack([new_id])) + " : " + json)
        tr.set(events.pack([new_id]), json)
        commit()
        io.sockets.emit('light', '')
      })
    })
  });
}

function save_chat(user, comment, id) {
  user = sanitize_for_json(user)
  comment = sanitize_for_json(comment)
  save_event('{"user":"' + user + '", "comment": "' + comment + '", "time": ' + (new Date()).getTime() + ', "id": "' + id + '", "type": "chat"}')
}

function save_presence(user, type) {
  user = sanitize_for_json(user)
  save_event('{"user":"' + user + '", "time": ' + (new Date()).getTime() + ', "type": "' + type + '"}')
}

function broadcast_users(err, users) {
  var user_list = []
  for (user in users) {
    var name = users[user].value.toString()
    user_list.push(name)
  }
}

function add_user(user) {
  fdb.directory.createOrOpen(db, 'users').then(function(users) {
    user = sanitize_for_json(user)
    db.doTransaction(function(tr, commit) {
      tr.set(users.pack([user]), user)
      var range = users.range()
      tr.getRange(range.begin, range.end).toArray(function(err, users) {
        commit(null, users)
      })
    }, broadcast_users)
  });
}

function remove_user(user) {
  fdb.directory.createOrOpen(db, 'users').then(function(users) {
    user = sanitize_for_json(user)
    db.doTransaction(function(tr, commit) {
      tr.clear(users.pack([user]))
      var range = users.range()
      tr.getRange(range.begin, range.end).toArray(function(err, users) {
        commit(null, users)
      })
    }, broadcast_users)
  });
}

app.use(bodyParser())


// ROUTES --------------------------

app.get('/', function (req, res) { res.sendfile(__dirname + '/public/index.html') })
app.get('/lights', function (req, res) { res.sendfile(__dirname + '/public/lights.html') })
app.get('/log', function(req, res) {
  load_all(function(data) {
    var chats = data.chats.slice(-100)
    data.chats = chats
    res.send(data)
  })
})
app.post('/message', function(req, res) {
  var name = req.body.name
  var comment = req.body.message
  var id = req.body.id
  save_chat(name, comment, id)
  res.send('')
})
app.use(express.static(__dirname + '/public'))

// SOCKET LISTENERS --------------------------

io.set('log level', 1)
io.sockets.on('connection', function (socket) {

  socket.on('join', function(name) {
    add_user(name)
    save_presence(name, 'joined')
  })
  
  socket.on('message', function (name, comment, id) {
    save_chat(name, comment, id)
  })

  socket.on('leave', function(name) {
    remove_user(name)
    save_presence(name, 'disconnected')
  })
})


// BOOT --------------------------

function lookup_latest_and_start_polling() {
  setInterval(check_db_for_updates, 1000)
}

function check_db_for_updates() {
  load_all(function(data) {
    io.sockets.emit('updates', data)
  }, id)
}

console.log('Opening the db...')
db = fdb.open()

function start_server() {
  var port = 1234
  if (process.argv[2]) {
    port = process.argv[2]
  }
  console.log('Starting the web server on port...', port)
  server.listen(port)
  console.log('Looking up latest and starting to poll...')
  lookup_latest_and_start_polling()
}

start_server()