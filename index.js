var level = require('level')
var pull = require('pull-stream')
var Write = require('pull-write')
var pl = require('pull-level')
var query = require('./query')
var select = require('./select')

var bytewise = require('bytewise')

var u = require('./util')
//sorted index.

function has (key, obj) {
  return !!obj[key]
  Object.hasOwnProperty(obj, key)
}

module.exports = function (path, links, version, codec) {
  codec = codec || require('bytewise')
  var db = level(path)

  //always write metada to the lowest key,
  //so the indexes do not interfeer
  //we don't want to encode this with the codec,
  //because then we can't change the codec safely
  //(prehaps the encoding of META is also some indexed value in another codec?)
  var META = '\x00'

  var indexes = [
    { key: 'SRD', value: ['source', 'rel', 'dest', 'ts'] },
    { key: 'DRS', value: ['dest', 'rel', 'source', 'ts'] },
    { key: 'RDS', value: ['rel', 'dest', 'source', 'ts'] }
  ]

  return {
    init: function (cb) {
      db.get(META, function (err, value) {
        if(value)
          try { value = JSON.parse(value) }
          catch (err) { return cb(null, 0) }

        if(err) //first time this was run
          cb(null, 0)
          
        //if the view has changed, rebuild entire index.
        //else, read current version.

        else if(version && value.version !== version)
          level.destroy(path, function (err) {
            if(err) return cb(err)
            db = level(path)
            cb(null, 0)
          })
        else
          cb(null, value.since || 0)
      })
    },
    write: function (cb) {
      return pull(
        Write(function (batch, cb) {
          db.batch(batch, cb)
        }, function (batch, data) {
          if(!batch)
            batch = [{
              key: META,
              value: {version: version, since: data.ts},
              valueEncoding: 'json',
              type: 'put'
            }]
          function push(ary) {
            batch.push({key: codec.encode(ary), value: ' ', type: 'put'})
          }

          links(data, function (link) {
            indexes.forEach(function (index) {
              var a = [index.key]
              for(var i = 0; i < index.value.length; i++) {
                var key = index.value[i]
                if(!has(key, link)) return
                a.push(link[key])
              }
              push(a)
            })
          })
          batch[0].value.since = data.ts
          return batch
        }, 100, cb)
      )
    },
    close: function (cb) {
      db.close(cb)
    },
    dump: function () {
      return pl.read(db, {keyEncoding: codec, gt: '\x00'})
    },
    read: function (opts) {
      if(!opts) opts = {query: {}}
      if(!opts.query) opts.query = {}

      var index = select(indexes, opts.query)
      var opts = query(index, opts.query)

      opts.values = false
      opts.keys = true
      opts.keyEncoding = codec

      return pull(
        pl.read(db, opts),
        //this just reads the index, suitable for links.
        pull.map(function (e) {
          var o = {}
          for(var i = 0; i < index.value.length; i++)
            o[index.value[i]] = e[i+1]
          return o
        })
      )
    }
  }
}
