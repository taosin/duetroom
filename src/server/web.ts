import {createReadStream,existsSync,statSync} from 'node:fs'
import {join,extname,resolve} from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.wav':'audio/wav','.glb':'model/gltf-binary','.hdr':'image/vnd.radiance','.woff2':'font/woff2'}
export function serveWeb(app:FastifyInstance){
  const root=resolve('dist/web')
  function send(reply:FastifyReply,dir:string,file:string){
    if(!/^[a-zA-Z0-9_.-]+$/.test(file) || !types[extname(file)])return reply.code(404).send()
    const path=join(root,dir,file)
    if(!existsSync(path)||!statSync(path).isFile())return reply.code(404).send()
    return reply.header('x-content-type-options','nosniff').type(types[extname(file)]).send(createReadStream(path))
  }
  app.get('/',(_,reply)=>send(reply,'','index.html'))
  for(const file of ['room.svg','mark.svg'])app.get('/'+file,(_,reply)=>send(reply,'',file))
  for(const dir of ['assets','call'])app.get<{Params:{file:string}}>('/'+dir+'/:file',(req,reply)=>send(reply,dir,req.params.file))
}
