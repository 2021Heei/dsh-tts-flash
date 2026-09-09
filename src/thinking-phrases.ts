/**
 * Built-in "waiting" phrases shown (and spoken) while the model is thinking.
 *
 * This array is the SINGLE SOURCE OF TRUTH shared by the host (audio file
 * generation / playback) and the client (text rotation): index i of this
 * array maps 1:1 to the cached audio file `<model-prefix>.p<i>.<ext>`, so
 * changing the array order changes which file belongs to which text —
 * regenerate (or clear) the waiting audio after editing.
 */
export const THINK_PHRASES: string[] = [
  '思考中…',
  '让子弹飞一会',
  '灵感酝酿中…',
  '神经元开会中',
  '马上就来…',
]
