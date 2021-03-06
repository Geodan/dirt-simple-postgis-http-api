const port = 3001;

const express = require('express');
const logger = require('morgan');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const fs = require('fs');

const app = express();

app.use(logger('dev'));
app.use(cors());
app.use(fileUpload());
app.use('/public', express.static(__dirname + '/public'));

app.post('/upload', (req, res, next) => {
  let uploadFile = req.files.filepond;
  const fileName = req.files.filepond.name;
  uploadFile.mv(
    `${__dirname}/public/files/${fileName}`,
    function (err) {
      if (err) {
        return res.status(500).send(err);
      }
      res.json({
        file: `${req.files.filepond.name}`
      })
    }
  )
});

app.get('/upload', (req, res) =>{
  url = req.query.fetch;
  console.log(url);
  res.json({
    file: 'index.html'
  });
})

app.delete('/upload', express.json({type: '*/*'}), (req, res) => {
    fs.unlinkSync(`${__dirname}/public/files/${req.body.file}`);
    res.json({
        file: 'done'
    });
});


app.listen(port);
console.log(`upload server listening on port ${port}`)

module.exports = app;