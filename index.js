const delay = require('delay')
const eos = require('then-eos')
const defer = require('promise-defer')
const randomize = require('randomize-array')
const distance = require('xor-distance')

const EventEmitter = require('events')

const DEFAULT_SAMPLE_SIZE = 16
const DEFAULT_PERCENT_FAR = 0.33
const DEFAULT_LOOKUP_TIMEOUT = 1000

module.exports =

class MMST extends EventEmitter {
  constructor ({
    // Own ID, should be a buffer
    // Other peers should see the same ID somehow
    // Might be good to calculate based on IP+port combo
    id,

    // Function to invoke in order to get a list of peers
    // Should return a stream that emits arrays IDs for potential peers
    // Peer IDs should be buffers, same as own ID
    lookup,

    // Function to invoke in order to establish a connection to a peer
    // Should take a peer ID from lookup
    // Should return a promise
    // Resolve to stream on successful connection
    // Reject on failed connection for whatever reason
    connect,

    // The higher the sample size, the more likely it'll connect to "close" peers
    // However, if the sample size is the number of peers, it can have supernodes
    sampleSize = DEFAULT_SAMPLE_SIZE,

    // The higher the percentage the more redundant connections will exist,
    // But the less likely it will be to have partitions
    percentFar = DEFAULT_PERCENT_FAR,

    // How long to lookup peers fore before giving up and using what you have
    lookupTimeout = DEFAULT_LOOKUP_TIMEOUT
  }) {
    super()
    this._lookup = lookup
    this._connect = connect
    this.sampleSize = sampleSize
    this.percentFar = percentFar
    this.lookupTimeout = lookupTimeout

    this.connectedPeers = new Set()
    this.hasConnectedFar = false
    this.destroyed = false
  }

  // This should be invoked when there's an incoming connection
  handleIncoming (id, connection) {
    this.addConnection(id, connection)
  }

  // Used internally
  addConnection (id, connection) {
    const stringId = id.toString('hex')
    this.connectedPeers.add(stringId)
    connection.once('close', () => {
      this.connectedPeers.delete(stringId)
    })
  }

  // Run the algorithm
  async run () {
    // If `destroyed` return
    if (this.destroyed) return

    const found = []
    const stream = this._lookup()

    const gotEnough = defer()

    stream.on('data', (peers) => {
      // Build up array of peers
      found.push(...peers)

      // Once the array has `sampleSize`, start connecting
      if (found.length >= this.sampleSize) gotEnough.resolve()
    })

    // Start looking up peers, with timeout
    await Promise.race([
      eos(stream),
      delay(this.lookupTimeout),
      defer.promise
    ])

    if (this.destroyed) return

    // Prep the peer sample

    let sample = found.slice()
    // If it's more than `sampleSize`, randomize the list and take sampleSize
    if (sample.length > this.sampleSize) {
      sample = randomize(found).slice(0, this.sampleSize)
    }

    // Sort by XOR distance, closest peers first
    sample.sort((a, b) => distance.gt(
      distance(this.id, a),
      distance(this.id, b)
    ))

    let connected = false

    // Connect to closest peer that isn't connected
    for (let peer of sample) {
      if (this.destroyed) return
      const stringId = peer.toString('hex')
      if (this.connectedPeers.has(stringId)) continue
      try {
        const connection = await this._connect(peer)
        connected = true
        this.addConnection(peer, connection)

        // Listen on the connection close to invoke `run` again
        connection.once('end', () => {
          this.run()
        })
        break
      } catch (e) {
        // Oh well
      }
    }

    if (!connected) {
      // Let the application know that we were unable to connect to any peer
      this.emit('nopeers')
      return
    }

    // If `hasConnectedFar`, return
    if (this.hasConnectedFar) return

    // Generate a random number [0, 1)
    const chanceFar = Math.random()

    // If > `percentFar` return
    if (chanceFar > this.percentFar) return

    // Order peers to have furthest first
    sample.reverse()

    // Find furthest peer that isn't already connected
    for (let peer of sample) {
      if (this.destroyed) return
      const stringId = peer.toString('hex')
      if (this.connectedPeers.has(stringId)) continue
      try {
        // Connect to the peer and set `hasConnectedFar` true
        const connection = await this._connect(peer)
        this.addConnection(peer, connection)
        this.hasConnectedFar = true

        // Listen on connection close and set `hasConnectedFar` false
        connection.once('end', () => {
          this.hasConnectedFar = false
        })
        break
      } catch (e) {
        // Oh well
      }
    }
  }

  async destroy () {
    // Set flag saying that this is destroyed to prevent looping
    this.destroyed = true
  }
}