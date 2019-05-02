const sm = require('@mapbox/sphericalmercator');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const merc = new sm({
  size: 256
})

// route query
const sql = (params, query) => {
  let bounds = merc.bbox(params.x, params.y, params.z, false, '900913')

  return `
  SELECT 
    ST_AsMVT(q, '${params.table}', 4096, 'geom')
  
  FROM (
    SELECT
      ${query.columns ? `${query.columns},` : ''}
      ST_AsMVTGeom(
        ST_Transform(${query.geom_column}, 3857),
        ST_MakeBox2D(ST_Point(${bounds[0]}, ${bounds[1]}), ST_Point(${
    bounds[2]
  }, ${bounds[3]}))
      ) geom

    FROM (
      SELECT
        ${query.columns ? `${query.columns},` : ''}
        ${query.geom_column},
        srid
      FROM 
        ${params.table},
        (SELECT ST_SRID(${query.geom_column}) AS srid FROM ${
    params.table
  } LIMIT 1) a
        
      WHERE       
        ST_transform(
          ST_MakeEnvelope(${bounds.join()}, 3857), 
          srid
        ) && 
        ${query.geom_column}

        -- Optional Filter
        ${query.filter ? `AND ${query.filter}` : ''}
    ) r

  ) q
  `
}

// route schema
const schema = {
  description:
    'Return table as Mapbox Vector Tile (MVT). The layer name returned is the name of the table.',
  tags: ['feature'],
  summary: 'return MVT',
  params: {
    table: {
      type: 'string',
      description: 'The name of the table or view.'
    },
    z: {
      type: 'integer',
      description: 'Z value of ZXY tile.'
    },
    x: {
      type: 'integer',
      description: 'X value of ZXY tile.'
    },
    y: {
      type: 'integer',
      description: 'Y value of ZXY tile.'
    }
  },
  querystring: {
    geom_column: {
      type: 'string',
      description: 'The geometry column of the table.',
      default: 'geom'
    },
    columns: {
      type: 'string',
      description:
        'Optional columns to return with MVT. The default is no columns.'
    },
    filter: {
      type: 'string',
      description: 'Optional filter parameters for a SQL WHERE statement.'
    }
  }
}

function cacheDirName(params) {
  return `${path.dirname(__dirname)}/cache/mvt/${params.table}/${params.z}/${params.x}/${params.y}`
}

function cacheFileName(query) {
  if (query.columns) {
    return query.columns;
  }
  return 'noquery';
}

function getCache(params, query) {
  const dirname = cacheDirName(params);
  const filename = cacheFileName(query);
  
  console.log(`getCache: ${dirname}`);
  return fsPromises.readFile(`${dirname}/${filename}`)
    .then(data=>data)
    .catch(error=>null);
}

function setCache(params, query, data) {
  const dirname = cacheDirName(params);
  const filename = cacheFileName(query);
  
  console.log(`setCache: ${dirname}`);
  return fsPromises.writeFile(`${dirname}/${filename}`, data)
    .then(() => {return})
    .catch(err=>err);
}

function lockCache(params, query) {
  const dirname = cacheDirName(params);
  const filename = cacheFileName(query);
  fs.mkdirSync(dirname, {recursive: true});
  return fsPromises.writeFile(`${dirname}/${filename}.lck`, 'lock', {flag: 'wx'})
    .then(()=>{
      return true
    })
    .catch(err=>{
      return fsPromises.stat(`${dirname}/${filename}.lck`)
        .then(st=>{
          console.log(Date.now() - st.ctimeMs);
          if (Date.now() - st.ctimeMs > 240000) {
            return unlockCache(params,query).then(()=>lockCache(params,query));
          } else {
            return false;
          }
        })
        .catch(err=>{
          console.log(err);
          return false;
        });
      });
}

function unlockCache(params, query){
  const dirname = cacheDirName(params);
  const filename = cacheFileName(query);
  return fsPromises.unlink(`${dirname}/${filename}.lck`)
    .then(()=>true)
    .catch(err=>{
      console.log(`unlockCache: error: ${err}`);
      return false;
    })
}

function wait(ms) {
  return new Promise((r, j)=>setTimeout(r, ms));
}

async function waitForCache(params, query) {
  const dirname = cacheDirName(params);
  const filename = cacheFileName(query);
  for (let i = 0; i < 180; i++) {
    console.log(`waiting for cache.. ${i}`);
    await wait(1000);
    data = await getCache(params, query);
    if (data) {
      console.log(`cache wait done.. ${i}`)
      return data;
    }
  }
  console.log(`cache wait failed`);
  return null;
}

// create route
module.exports = function(fastify, opts, next) {
  fastify.route({
    method: 'GET',
    url: '/mvt/:table/:z/:x/:y',
    schema: schema,
    handler: async function(request, reply) {
      const data = await getCache(request.params, request.query);
      if (data) {
        if (data.length === 0) {
          reply.code(204)
        }
        reply.header('Content-Type', 'application/x-protobuf').send(data);
      } else {
        const lock = await lockCache(request.params, request.query);
        if (!lock) {
          console.log('lock failed')
          const delayedData = await waitForCache(request.params, request.query);
          if (!delayedData) {
            console.log('return cache wait timeout');
            return reply.send({
              statusCode: 500,
              error: 'Internal Server Error',
              message: 'cache wait timeout'
            })
          }
          if (delayedData.length === 0) {
            reply.code(204);
          }
          reply.header('Content-Type', 'application/x-protobuf').send(delayedData);
        } else {
          fastify.pg.connect(onConnect)

          function onConnect(err, client, release) {
            if (err) {
              unlockCache(request.params, request.query);
              return reply.send({
                statusCode: 500,
                error: 'Internal Server Error',
                message: 'unable to connect to database server'
              })
            }
            client.query(sql(request.params, request.query), function onResult(
              err,
              result
            ) {
              release()
              if (err) {
                unlockCache(request.params, request.query);
                reply.send(err)
              } else {
                const mvt = result.rows[0].st_asmvt
                if (mvt.length === 0) {
                  reply.code(204)
                }
                reply.header('Content-Type', 'application/x-protobuf').send(mvt);
                setCache(request.params, request.query, mvt);
                unlockCache(request.params, request.query);
              }
            })
          }
        }
      }
    }  
  })
  next()
}

module.exports.autoPrefix = '/v1'
