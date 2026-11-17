import {useCallback,useLayoutEffect,useRef} from 'react'

// Stable identity for memoized descendants, while a click always uses the
// latest committed course, reader and draft state from the owning component.
export function useEventCallback<Args extends unknown[],Result>(callback:(...args:Args)=>Result){
  const current=useRef(callback)
  useLayoutEffect(()=>{current.current=callback},[callback])
  return useCallback((...args:Args)=>current.current(...args),[])
}
