const path = require('path')

module.exports = {
    includePaths: [
        path.join(__dirname, "include-path")
    ],
    silenceDeprecations: ['legacy-js-api']
}
