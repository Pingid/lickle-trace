import { defineConfig, Place, Match } from '@lickle/docs/config'

export default defineConfig({
  name: '@lickle/trace',
  layout: Place.compose(
    Place.bucket(Match.kinds('interface', 'type-alias'), 'types'),
    Place.bucket(Match.kinds('variable', 'function'), 'functions'),
    Place.visibility(Match.kinds('function', 'enum', 'variable'), { inline: true }),
  ),
})
