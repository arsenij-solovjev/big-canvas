var Config = require("./Config");
var BigInteger = require("big-integer");

function Point(x, y) {
  this.x = BigInteger(x);
  this.y = BigInteger(y);
}

Point.prototype.toData = function() {
  return {
    x: this.x.toString(),
    y: this.y.toString()
  };
};

Point.prototype.toLocation = function() {
  var size = Config.TILE_SIZE,
    x = this.x,
    y = this.y,
    col,
    row;
  //determine the column
  if(!x.isNegative()) {
    col = x.divide(size);
  } else {
    var dm = x.divmod(size);
    col = dm.quotient;
    if(!dm.remainder.equals(BigInteger.zero))
       col = col.prev();
  }
  //determine the row
  if(!y.isNegative()) {
    row = y.divide(size);
  } else {
    var dm = y.divmod(size);
    row = dm.quotient;
    if(!dm.remainder.equals(BigInteger.zero))
      row = row.prev();
  }
  return new TileLocation(col, row);
};

function TileLocation(column, row) {
  this.column = BigInteger(column);
  this.row = BigInteger(row);
}

TileLocation.prototype.toData = function() {
  return {
    column: this.column.toString(),
    row: this.row.toString()
  };
};

module.exports = {
  Point: Point,
  TileLocation: TileLocation
};
