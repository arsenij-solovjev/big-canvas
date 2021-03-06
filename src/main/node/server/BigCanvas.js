var Config = require("./Config");

var lock = require("./lock");

var DatabaseConnection = require("./DatabaseConnection");

var BigInteger = require("big-integer");
var Types = require("./ServerTypes");
var Point = Types.Point;
var BoundingBox = Types.BoundingBox;
var Window = Types.Window;
var WindowTree = Types.WindowTree;
var RenderJobQueue = Types.RenderJobQueue;

var BigCanvasDefinitions = require("./BigCanvasDefinitions");
var _ = require("underscore");

var Users = require("./data/Users");
var Actions = require("./data/Actions");
var Tiles = require("./data/Tiles");
var Versions = require("./data/Versions");
var Deltas = require("./data/Deltas");
var Cache = require("../Cache");

var Canvas = require("canvas");
var fs = require("fs");

var socketIds = BigInteger(0);

/**
 *
 *  @constructor BigCanvasSocket
 *  @param {TODO what type is it?} wsSocket the socket to connect to
 *  @param {String} userId the id of the user
 *
 * */
function BigCanvasSocket(wsSocket, userId) {
  var id = socketIds.toString(),
      window = null;
  socketIds = socketIds.next();
  this.getId = function() { return id; };
  this.send = function(obj) {
    try {
      wsSocket.send(JSON.stringify(obj));
    } catch(ex) {
      console.log("Error while sending message ("+ex.message+").");
    }
  };
  this.getUserId = function() { return userId; };
  this.close = function(obj) { wsSocket.close(); };
  this.getWindow = function() { return window; };
  this.setWindow = function(win) { window = win; };
}

/**
 *
 * @constructor BigCanvas
 * TODO what does it represent?
 *
 */
function BigCanvas() {
  var self = this;
  var sockets = {};
  var windowTree = new WindowTree();
  var jobs = new RenderJobQueue();
  var updateQueue = {};

  function lockCanvas(callback) {
    lock("canvas", callback);
  }

  function enqueueUpdate(socketId, update) {
    if(!(socketId in updateQueue))
      updateQueue[socketId] = {
        createdOn: new Date().getTime(),
        updates: [update]
      };
    else
      updateQueue[socketId].updates.push(update);
  }

  function enqueueTileUpdate(tileUpdate) {
    var location = tileUpdate.location;
    var socketIds = windowTree.getWindowsByLocation(location);
    _.each(socketIds, function(socketId) {
      enqueueUpdate(socketId, tileUpdate);
    });
  }

  function enqueueActionUpdate(actionId, action, userId, region) {
    //TODO implement filter: kick out all actions that are known by the client
    var actionUpdate = {
      type: "ACTION",
      actionId: actionId,
      action: action,
      userId: userId
    };
    var socketIds = windowTree.getWindowsByRegion(region);
    _.each(socketIds, function(socketId) {
      enqueueUpdate(socketId, actionUpdate);
    });
  }

  //send update events
  setInterval(function() {
    var newUpdateQueue = {};
    var now = new Date().getTime();
    _.each(updateQueue, function(entry, socketId) {
      if(now - entry.createdOn > 500) { //TODO write update interval to config
        var socket = sockets[socketId];
        if(socket) //TODO dirty solution, should be never null or undefined
          self.Server.onUpdate(socket, entry.updates);
      } else
        newUpdateQueue[socketId] = entry;
    });
    updateQueue = newUpdateQueue;
  }, 200);

  function jobStep(location) {
    //open a database connection
    var connection = new DatabaseConnection();
    connection.connect(function(err) {
      if(err) { connection.end(); return; }
      //lock tile
      var locks = [];
      function unlock() {
        connection.end();
        _.each(locks, function(done) { done(); });
        locks = [];
      }
      Tiles.lock(location, function(done) {
        locks.unshift(done);
        function fail(ex) {
          console.log(ex); //TODO find a better fail behaviour???
          unlock();
          jobStep(location);
        }
        function success() {
          unlock();
          jobStep(location);
        }
        Versions.getTileHistoryByLocation(connection, location, function(err, result) {
          if(err) { fail(err); return; }
          try {
            if(result.tailRevisions.length == 0) {
              jobs.remove(location);
              unlock();
              return; //exit eventually
            }
            Versions.getRevision(connection, location, result.baseRevisionId, function(err, baseCanvas) {
              if(err) { fail(err); return; }
              var revision = result.tailRevisions[0];
              var revisionId = revision.revisionId;
              var actionId = revision.actionId;
              Actions.get(connection, actionId, function(err, actionData) {
                if(err) { fail(err); return; }
                var action = actionData["actionObject"];
                Deltas.draw(actionId, action, function(err, delta) {
                  if(err) { fail(err); return; }
                  try {
                    var deltaCanvas = delta.getTile(location);
                    Deltas.applyDelta(baseCanvas, deltaCanvas, action, function(err, resultCanvas) {
                      if(err) { fail(err); return; }
                      Versions.setRevision(connection, location, revisionId, resultCanvas, function(err) {
                        if(err) { fail(err); return; }
                        //broadcast
                        try {
                          enqueueTileUpdate({
                            type: "RENDERED",
                            location: location,
                            revisionId: revisionId
                          });
                          //finally close the step
                          success();
                        } catch(ex) { fail(ex); }
                      });
                    });
                  } catch(ex) { fail(ex); }
                });
              });
            });
          } catch(ex) { fail(ex); }
        });
      });
    });
  }

  function addRenderJob(location) {
    Tiles.lock(location, function(done) {
      if(jobs.add(location))
        jobStep(location);
      done();
    });
  }

  //setup server stub
  this.Server = new BigCanvasDefinitions.Interfaces.Main.Server({
    connect: function(socket) {
      sockets[socket.getId()] = socket;
    },
    disconnect: function(socket) {
      //remove window from tree
      var oldWindow = socket.getWindow(),
          socketId = socket.getId();
      if(oldWindow != null)
        windowTree.removeWindow(oldWindow, socketId);
      //delete from sockets list
      delete sockets[socketId];
    },
    //remote procedure call implementations
    setWindow: function(socket, x, y, width, height, callback) {
      try {
        var oldWindow = socket.getWindow(),
          newWindow = new Window(x, y, width, height),
          socketId = socket.getId(),
          connection = new DatabaseConnection(),
          locks = [];
        function unlock() {_.each(locks, function(done) { done(); }); connection.end(); }
        function fail(ex) { callback(ex); unlock(); }
        connection.connect(function(err) {
          if(err) { fail(err); return; }
          lockCanvas(function(canvasDone) {
            locks.unshift(canvasDone);
            try {
              //reset window
              if(oldWindow != null)
                windowTree.removeWindow(oldWindow, socketId);
              windowTree.addWindow(newWindow, socketId);
              //collect region data
              var region = newWindow.getRegion();
              _.each(region, addRenderJob);
              Tiles.lock(region, function(tilesDone) {
                locks.unshift(tilesDone);
                Versions.getTileHistoryByRegion(connection, region, function(err, updates) {
                  if(err) { fail(err); return; }
                  _.each(updates, function(update) {
                    enqueueTileUpdate(update);
                  });
                  callback();
                  unlock();
                });
              });
            } catch(ex) { fail(ex); }
          });
        });
      } catch(ex) {
        callback(ex);
      }
    },
    sendAction: function(socket, action, callback) {
      var server = this;
      function broadcastAndRender(actionId, action, userId, region, updates) {
        //broadcast
        enqueueActionUpdate(actionId, action, userId, region);
        _.each(updates, function(update) {
          if(update.type == "ACTION")
            enqueueActionUpdate(update.actionId, update.action, update.userId, update.region);
          else
            enqueueTileUpdate(update);
        });
        //render
        _.each(region, addRenderJob);
      }

      var connection = new DatabaseConnection();
      connection.connect(function(err) {
        if(err) { connection.end(); callback(err); return; }
        var locks = [],
            userId = socket.getUserId();
        function unlock() {
          connection.end();
          _.each(locks, function(done) { done(); });
          locks = [];
        }
        function success(actionId) {
          unlock();
          callback(null, actionId);
        }
        function fail(ex) {
          unlock();
          callback(ex);
        }

        //lock canvas
        lockCanvas(function(canvasDone) {
          locks.unshift(canvasDone);
          //lock user
          Users.lock(userId, function(userDone) {
            //save unlock callback
            locks.unshift(userDone);
            //get user
            Users.get(connection, userId, function(err, user) {
              //handle error
              if(err) { fail(err); return; }
              //handle action
              switch(action.type) {
                case "BRUSH":
                case "ERASER":
                  //check if stroke <= BoundingBox(4096x4096)
                  var maxSize = Config.ACTION_MAX_STROKE_SIZE,
                    width = BigInteger(action.width),
                    opacity = action.opacity,
                    bb = new BoundingBox(),
                    stroke = _.map(action.stroke, function(point) {
                      return new Point(point.x, point.y);
                    });
                  _.each(stroke, function(point) { bb.addPoint(point); });
                  bb.extend(Math.ceil(width / 2));
                  if(bb.getWidth().greater(maxSize) || bb.getHeight().greater(maxSize)) {
                    fail(new Error("Stroke is too big."));
                    return;
                  }

                  function performAction(newActionId, previousActionId) {
                    Deltas.draw(newActionId, action, function(err, delta) {
                      if(err) { fail(err); return; }
                      try {
                        var region = delta.getRegion();
                        //lock region
                        Tiles.lock(region, function(tilesDone) {
                          //save unlock callback
                          locks.unshift(tilesDone);
                          //start transaction
                          var transaction = connection.startTransaction();
                          function rollback(err) {
                            transaction.rollback();
                            fail(err);
                          }
                          function commit(rslt, updates) {
                            transaction.commit(function(err, info) {
                              if(err) {
                                fail(err);
                              } else {
                                success(rslt);
                                broadcastAndRender(newActionId, action, userId, region, updates);
                              }
                            });
                          }
                          Actions.create(transaction, newActionId, action, userId, previousActionId, region, function(err) {
                            if(err) { rollback(err); return; }
                            Users.setLastActionId(transaction, userId, newActionId, function(err) {
                              if(err) { rollback(err); return; }
                              Tiles.appendAction(transaction, region, newActionId, function(err) {
                                if(err) { rollback(err); return; }
                                Versions.updateHistoryForRegion(transaction, region, newActionId, function(err, updates) {
                                  if(err) { rollback(err); return; }
                                  Users.incrementUsageStatistics(transaction, userId, action.type, function(err) {
                                    if(err) { rollback(err); return; }
                                    if(previousActionId !== "-1") {
                                      Actions.setNextActionId(transaction, previousActionId, newActionId, function(err) {
                                        if(err) { rollback(err); return; }
                                        commit(newActionId, updates);
                                      });
                                    } else {
                                      Users.setFirstActionId(transaction, userId, newActionId, function(err) {
                                        if(err) { rollback(err); return; }
                                        commit(newActionId, updates);
                                      });
                                    }
                                  });
                                });
                              });
                            });
                          });
                          transaction.execute();
                        });
                      } catch(ex) {
                        fail(ex);
                      }
                    });
                  }
                  //get new action id
                  Actions.newId(connection, function(err, newActionId) {
                    if(err) { fail(err); return; }
                    //read user.lastAction
                    Users.get(connection, userId, function(err, user) {
                      if(err) { fail(err); return; }
                      var noLastAction = user.lastActionId === "-1";
                      //lock new Action
                      Actions.lock(newActionId, function(newActionDone) {
                        locks.unshift(newActionDone);
                        if(!noLastAction) {
                          Actions.lock(user.lastActionId, function(previousActionDone) {
                            locks.unshift(previousActionDone);
                            performAction(newActionId, user.lastActionId);
                          });
                        } else
                          performAction(newActionId, "-1");
                      });
                    });
                  });
                  break;
                case "UNDO":
                  try {
                    //get users last action
                    var lastActionId = user.lastActionId;
                    if(lastActionId === "-1")
                      throw new Error("No last action found (userId: "+userId+")!");
                    //lock action
                    Actions.lock(lastActionId, function(actionDone) {
                      //save unlock callback
                      locks.unshift(actionDone);
                      //read action
                      Actions.get(connection, lastActionId, function(err, lastAction) {
                        //handle error
                        if(err) { fail(err); return; }
                        try {
                          //if action.undone==true then abort, error
                          if(lastAction.undone)
                            throw new Error("Last action is already undone. Debug please (userId="+userId+", actionId="+lastActionId+").");
                          //lock tiles
                          Tiles.lock(lastAction.region, function(tilesDone) {
                            //save unlock callback
                            locks.unshift(tilesDone);

                            //start transaction
                            var transaction = connection.startTransaction();
                            function rollback(err) {
                              transaction.rollback();
                              fail(err);
                            }
                            function commit(rslt, updates) {
                              transaction.commit(function(err, info) {
                                if(err) {
                                  fail(err);
                                } else {
                                  success(rslt);
                                  broadcastAndRender(lastActionId, action, userId, lastAction.region, updates);
                                }
                              });
                            }
                            Actions.setUndone(transaction, lastActionId, true, function(err) {
                              if(err) { rollback(err); return; }
                              Users.setLastActionId(transaction, userId, lastAction.previousActionId, function(err) {
                                if(err) { rollback(err); return; }
                                Versions.updateHistoryForRegion(transaction, lastAction.region, lastActionId, function(err, updates) {
                                  if(err) { rollback(err); return; }
                                  Users.incrementUsageStatistics(transaction, userId, action.type, function(err) {
                                    if(err) { rollback(err); return; }
                                    commit(lastActionId, updates);
                                  });
                                });
                              });
                            });
                            transaction.execute();
                          });
                        } catch(ex) { fail(ex); }
                      });
                    });
                  } catch(ex) { fail(ex); }
                  break;
                case "REDO":
                  function redoAction(actionId) {
                    Actions.lock(actionId, function(actionDone) {
                      //save unlock callback
                      locks.unshift(actionDone);
                      //read action
                      Actions.get(connection, actionId, function(err, nextAction) {
                        if(err) { fail(err); return; }
                        try {
                          if(!nextAction.undone)
                            throw new Error("Cannot redo action (userId: "+userId+"; actionId: "+actionId+").");

                          //start transaction
                          var transaction = connection.startTransaction();
                          function rollback(err) {
                            transaction.rollback();
                            fail(err);
                          }
                          function commit(updates) {
                            transaction.commit(function(err, info) {
                              if(err) {
                                fail(err);
                              } else {
                                success(actionId);
                                broadcastAndRender(actionId, action, userId, nextAction.region, updates);
                              }
                            });
                          }
                          Actions.setUndone(transaction, actionId, false, function(err) {
                            if(err) { rollback(err); return; }
                            Users.setLastActionId(transaction, userId, actionId, function(err) {
                              if(err) { rollback(err); return; }
                              Versions.updateHistoryForRegion(transaction, nextAction.region, actionId, function(err, updates) {
                                if(err) { rollback(err); return; }
                                Users.incrementUsageStatistics(transaction, userId, action.type, function(err) {
                                  if(err) { rollback(err); return; }
                                  commit(updates);
                                });
                              });
                            });
                          });
                          transaction.execute();
                        } catch(ex) { fail(ex); }
                      });
                    });
                  }
                  try {
                    //get users last action
                    var lastActionId = user.lastActionId;
                    //if there is no last action, check first action (next candidate for redoing)
                    if(lastActionId === "-1") {
                      var firstActionId = user.firstActionId;
                      if(firstActionId === "-1")
                        throw new Error("No redoable action found (userId: "+userId+")!");
                      redoAction(firstActionId);
                    } else {
                      //lock action
                      Actions.lock(lastActionId, function(actionDone) {
                        //save unlock callback
                        locks.unshift(actionDone);
                        //read action
                        Actions.get(connection, lastActionId, function(err, lastAction) {
                          //handle error
                          if(err) { fail(err); return; }
                          try {
                            var nextActionId = lastAction.nextActionId;
                            if(nextActionId === "-1")
                              throw new Error("No next action found (userId: "+userId+"; actionId: "+lastActionId+").");
                            redoAction(nextActionId);
                          } catch(ex) { fail(ex); }
                        });
                      });
                    }
                  } catch(ex) { fail(ex); }
                  break;
              }
            });
          });
        });
      });
    }
  });
}

module.exports = {
  BigCanvasSocket: BigCanvasSocket,
  BigCanvas: BigCanvas
};