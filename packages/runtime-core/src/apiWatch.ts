import {
  isRef,
  isShallow,
  Ref,
  ComputedRef,
  ReactiveEffect,
  isReactive,
  ReactiveFlags,
  EffectScheduler,
  DebuggerOptions,
  getCurrentScope
} from '@vue/reactivity'
import { SchedulerJob, queueJob } from './scheduler'
import {
  EMPTY_OBJ,
  isObject,
  isArray,
  isFunction,
  isString,
  hasChanged,
  NOOP,
  remove,
  isMap,
  isSet,
  isPlainObject,
  extend
} from '@vue/shared'
import {
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  setCurrentInstance,
  unsetCurrentInstance
} from './component'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { queuePostRenderEffect } from './renderer'
import { warn } from './warning'
import { DeprecationTypes } from './compat/compatConfig'
import { checkCompatEnabled, isCompatEnabled } from './compat/compatConfig'
import { ObjectWatchOptionItem } from './componentOptions'
import { useSSRContext } from '@vue/runtime-core'
import { SSRContext } from '@vue/server-renderer'

export type WatchEffect = (onCleanup: OnCleanup) => void

export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onCleanup: OnCleanup
) => any

type MapSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? Immediate extends true
      ? V | undefined
      : V
    : T[K] extends object
    ? Immediate extends true
      ? T[K] | undefined
      : T[K]
    : never
}

type OnCleanup = (cleanupFn: () => void) => void

export interface WatchOptionsBase extends DebuggerOptions {
  flush?: 'pre' | 'post' | 'sync'
}

export interface WatchOptions<Immediate = boolean> extends WatchOptionsBase {
  immediate?: Immediate
  deep?: boolean
}

export type WatchStopHandle = () => void

// Simple effect.
/**
 * watchEffect 立即运行一个函数，同时响应式地追踪其依赖，并在依赖更改时重新执行。
 * @param effect 要运行的副作用函数
 * @param options 是一个可选的选项，可以用来调整副作用的刷新时机或调试副作用的依赖。
 * @returns 用来停止该副作用的函数
 */
export function watchEffect(
  effect: WatchEffect,
  options?: WatchOptionsBase
): WatchStopHandle {
  return doWatch(effect, null, options)
}

/**
 * watchPostEffect
 * @param effect 
 * @param options 
 * @returns 
 */
export function watchPostEffect(
  effect: WatchEffect,
  options?: DebuggerOptions
) {
  return doWatch(
    effect,
    null,
    __DEV__ ? extend({}, options as any, { flush: 'post' }) : { flush: 'post' }
  )
}

export function watchSyncEffect(
  effect: WatchEffect,
  options?: DebuggerOptions
) {
  return doWatch(
    effect,
    null,
    __DEV__ ? extend({}, options as any, { flush: 'sync' }) : { flush: 'sync' }
  )
}

// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}

type MultiWatchSources = (WatchSource<unknown> | object)[]

// overload: array of multiple sources + cb
export function watch<
  T extends MultiWatchSources,
  Immediate extends Readonly<boolean> = false
>(
  sources: [...T],
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: multiple sources w/ `as const`
// watch([foo, bar] as const, () => {})
// somehow [...T] breaks when the type is readonly
export function watch<
  T extends Readonly<MultiWatchSources>,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle
/**
 * 
 * @param source 监听源
 * @param cb 回调函数
 * @param options 配置 
 * @returns WatchStopHandle停止侦听函数
 */
// implementation
export function watch<T = any, Immediate extends Readonly<boolean> = false>(
  source: T | WatchSource<T>,
  cb: any,
  options?: WatchOptions<Immediate>
): WatchStopHandle {
  if (__DEV__ && !isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source as any, cb, options)
}
/**
 * watch、watchEffect、watchSyncEffect、watchPostEffect的实现均是通过一个doWatch函数实现。
 * dowatch中会首先生成一个getter函数。
 * 
 * 如果是watchAPI，那么这个getter函数中会根据传入参数，访问监听数据源中的属性（可能会递归访问对象中的属性，
 * 取决于deep），并返回与数据源数据类型一致的数据（如果数据源是ref类型，getter函数返回ref.value；
 * 
 * 如果数据源类型是reactive，getter函数返回值也是reactive；如果数据源是数组，那么getter函数返回值也应该是数组；
 * 
 * 如果数据源是函数类型，那么getter函数返回值是数据源的返回值）。
 * 
 * 如果是watchEffect等API，那么getter函数中会执行source函数。然后定义一个job函数。如果是watch，
 * job函数中会执行effect.run获取新的值，并比较新旧值，是否执行cb；
 * 如果是watchEffect等API，job中执行effect.run。那么如何只监听到state.obj.num的变换呢？
 

* 当声明完job，会紧跟着定义一个调度器，这个调度器的作用是根据flush将job放到不同的任务队列中。
* 然后根据getter与调度器scheduler初始化一个ReactiveEffect`实例。接着进行初始化：如果是watch，
* 如果是立即执行，则马上执行job，否则执行effect.run更新oldValue；如果flush是post，会将effect.run
* 函数放到延迟队列中延迟执行；其他情况执行effect.run。最后返回一个停止watch的函数。
 * @param source 监听源
 * @param cb 回调函数
 * @param param2 WatchOptions{ immediate, deep, flush, onTrack, onTrigger }
 * @returns 停止侦听函数
 */
function doWatch(
  source: WatchSource | WatchSource[] | WatchEffect | object,
  cb: WatchCallback | null,
  { immediate, deep, flush, onTrack, onTrigger }: WatchOptions = EMPTY_OBJ
): WatchStopHandle {
  if (__DEV__ && !cb) {
    //首先需要对immediate、deep做校验，如果cb为null，immediate、deep不为undefined进行提示。
    
    if (immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
    if (deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
  }

  //侦听源不合法
  const warnInvalidSource = (s: unknown) => {
    warn(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`
    )
  }

  // 当前组件
  const instance =
    getCurrentScope() === currentInstance?.scope ? currentInstance : null
  // const instance = currentInstance
  // 副作用函数，在初始化effect时使用
  let getter: () => any
  //强制触发侦听
  let forceTrigger = false
  //是否为多数据源
  let isMultiSource = false

  /**
   * 如果source是ref类型，getter是个返回source.value的函数，
   * forceTrigger取决于source是否是浅层响应式。
   */
  if (isRef(source)) {
    getter = () => source.value
    forceTrigger = isShallow(source)
  } else if (isReactive(source)) {
    //如果source是reactive类型，getter是个返回source的函数，并将deep设置为true
    getter = () => source
    deep = true
  } else if (isArray(source)) {
    //如果source是个数组，将isMultiSource设为true，
    //forceTrigger取决于source是否有reactive类型的数据，
    //getter函数中会遍历source，针对不同类型的source做不同处理
    isMultiSource = true
    forceTrigger = source.some(s => isReactive(s) || isShallow(s))
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return traverse(s)
        } else if (isFunction(s)) {
          return callWithErrorHandling(s, instance, ErrorCodes.WATCH_GETTER)
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    /**
     * 如果source是个function。
     * 存在cb的情况下，getter函数中会执行source，这里source会通过callWithErrorHandling函数执行，
     * 在callWithErrorHandling中会处理source执行过程中出现的错误；
     * 
     * 不存在cb的话，在getter中，如果组件已经被卸载了，直接return，否则判断cleanup（cleanup是
     * 在watchEffect中通过onCleanup注册的清理函数），如果存在cleanup执行cleanup，接着执行source，
     * 并返回执行结果。source会被callWithAsyncErrorHandling包装，该函数作用会处理source执行过程
     * 中出现的错误，与callWithErrorHandling不同的是，callWithAsyncErrorHandling会处理异步错误。
     */
    if (cb) {
      // getter with cb
      getter = () =>
        callWithErrorHandling(source, instance, ErrorCodes.WATCH_GETTER)
    } else {
      // no cb -> simple effect
      //watchEffect
      getter = () => {
        //如果组件没有挂载，直接return
        if (instance && instance.isUnmounted) {
          return
        }
        //如果清晰函数，则执行清理函数
        if (cleanup) {
          cleanup()
        }
        //执行source，传入onCleanup，用来注册清理函数
        return callWithAsyncErrorHandling(
          source,
          instance,
          ErrorCodes.WATCH_CALLBACK,
          [onCleanup]
        )
      }
    }
  } else {
    //其他情况，getter会被赋予一个空函数
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  //对vue2的数组的进行兼容性处理，breaking-changes/watch
  // 2.x array mutation watch compat
  if (__COMPAT__ && cb && !deep) {
    const baseGetter = getter
    getter = () => {
      const val = baseGetter()
      if (
        isArray(val) &&
        checkCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance)
      ) {
        traverse(val)
      }
      return val
    }
  }
//如果存在cb并且deep为true，那么需要对数据进行深度监听，这时，会重新对getter赋值，
//在新的getter函数中递归访问之前getter的返回结果。
  if (cb && deep) {
    const baseGetter = getter
    //traverse()
    getter = () => traverse(baseGetter())
  }
/* 到此，getter函数（getter函数中会尽可能访问响应式数据，
尤其是deep为true并存在cb的情况时，会调用traverse完成对source的递归属性访问）、
forceTrigger、isMultiSource已经被确定，
接下来声明了两个变量：cleanup、onCleanup。
onCleanup会作为参数传递给watchEffect中的effect函数。
当onCleanup执行时，会将他的参数通过callWithErrorHandling
封装赋给cleanup及effect.onStop（effect在后文中创建）。
 */

  let cleanup: () => void
  let onCleanup: OnCleanup = (fn: () => void) => {
    cleanup = effect.onStop = () => {
      callWithErrorHandling(fn, instance, ErrorCodes.WATCH_CLEANUP)
    }
  }

  // in SSR there is no need to setup an actual effect, and it should be noop
  // unless it's eager or sync flush
  //在SSR中，不需要设置实际的effect，它应该是noop，除非它是eager或sync flush
  let ssrCleanup: (() => void)[] | undefined
  if (__SSR__ && isInSSRComponentSetup) {
    // we will also not call the invalidate callback (+ runner is not set up)
    onCleanup = NOOP
    if (!cb) {
      getter()
    } else if (immediate) {
      callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
        getter(),
        isMultiSource ? [] : undefined,
        onCleanup
      ])
    }
    if (flush === 'sync') {
      const ctx = useSSRContext() as SSRContext
      ssrCleanup = ctx.__watcherHandles || (ctx.__watcherHandles = [])
    } else {
      return NOOP
    }
  }

  //然后声明了一个oldValue和job变量。如果是多数据源oldValue是个数组，否则是个对象。
  let oldValue: any = isMultiSource
    ? new Array((source as []).length).fill(INITIAL_WATCHER_VALUE)
    : INITIAL_WATCHER_VALUE

  /**
    * job函数的作用是触发cb(watch)或执行effect.run(watchEffect)。
    * job函数中会首先判断effect的激活状态，如果未激活，则return。
    * 然后判断如果存在cb，调用effet.run获取最新值，下一步就是触发cb，这里触发cb需要满足以下条件的任意一个条件即可：
      * 1.深度监听deep===true
      * 2.强制触发forceTrigger===true
      * 3.如果多数据源，newValue中存在与oldValue中的值不相同的项（利用Object.is判断）；如果不是多数据源，newValue与oldValue不相同。
      * 4.开启了vue2兼容模式，并且newValue是个数组，并且开启了WATCH_ARRAY
    
  只要符合上述条件的任意一条，便可已触发cb，在触发cb之前会先调用cleanup函数。
  执行完cb后，需要将newValue赋值给oldValue。
  如果不存在cb，那么直接调用effect.run即可。
  */
  const job: SchedulerJob = () => {
    if (!effect.active) {
      return
    }
    if (cb) {
      // watch(source, cb)
      const newValue = effect.run()
      if (
        deep ||
        forceTrigger ||
        (isMultiSource
          ? (newValue as any[]).some((v, i) =>
              hasChanged(v, (oldValue as any[])[i])
            )
          : hasChanged(newValue, oldValue)) ||
        (__COMPAT__ &&
          isArray(newValue) &&
          isCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance))
      ) {
        // cleanup before running cb again
        if (cleanup) {
          cleanup()
        }
        callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
          newValue,
          // 如果oldValue为INITIAL_WATCHER_VALUE，说明是第一次watch，那么oldValue是undefined
          // pass undefined as the old value when it's changed for the first time
          oldValue === INITIAL_WATCHER_VALUE
            ? undefined
            : isMultiSource && oldValue[0] === INITIAL_WATCHER_VALUE
            ? []
            : oldValue,
          onCleanup
        ])
        oldValue = newValue
      }
    } else {
      // watchEffect
      effect.run()
    }
  }

  // important: mark the job as a watcher callback so that scheduler knows
  // it is allowed to self-trigger (#1727)
  job.allowRecurse = !!cb

  //声明一个调度器，在scheduler中会根据flush的不同决定job的触发时机：
  let scheduler: EffectScheduler
  if (flush === 'sync') {
    //直接执行
    scheduler = job as any // the scheduler function gets called directly
  } else if (flush === 'post') {
    // 延迟执行，将job添加到一个延迟队列，这个队列会在组件挂在后、更新的生命周期中执行
    scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)
  } else {
    // default: 'pre'
    // 默认 pre，将job添加到一个优先执行队列，该队列在挂载前执行
    job.pre = true
    if (instance) job.id = instance.uid
    scheduler = () => queueJob(job)
  }

  //此时，getter与scheduler准备完成，创建effect实例。
  const effect = new ReactiveEffect(getter, scheduler)

  if (__DEV__) {
    effect.onTrack = onTrack
    effect.onTrigger = onTrigger
  }
/**
 * 创建effect实例后，开始首次执行副作用函数。这里针对不同情况有多个分支：
 * 如果存在cb的情况:
 * 如果immediate为true，执行job，触发cb
 * 否则执行effect.run()进行依赖的收集，并将结果赋值给oldValue
 * 如果flush===post，会将effect.run推入一个延迟队列中
 * 其他情况，也就是watchEffect，则会执行effect.run进行依赖的收集
 */
  // initial run
  if (cb) {
    if (immediate) {
      job()
    } else {
      oldValue = effect.run()
    }
  } else if (flush === 'post') {
    queuePostRenderEffect(
      effect.run.bind(effect),
      instance && instance.suspense
    )
  } else {
    effect.run()
  }

  /**
   * 最后，返回一个函数，这个函数的作用是停止watch对数据源的监听。
   * 在函数内部调用effect.stop()将effect置为失活状态，
   * 如果存在组件实例，并且组件示例中存在effectScope，
   * 那么需要将effect从effectScope中移除。
   */
  const unwatch = () => {
    effect.stop()
    if (instance && instance.scope) {
      remove(instance.scope.effects!, effect)
    }
  }

  if (__SSR__ && ssrCleanup) ssrCleanup.push(unwatch)
  return unwatch
}

// this.$watch
/**
 * $watch
 * @param this 组件实例 
 * @param source watch监听源
 * @param value 回调函数或者bjectWatchOptionItem
 * @param options watch配置
 * @returns 停止侦听的函数
 */
export function instanceWatch(
  this: ComponentInternalInstance,
  source: string | Function,
  value: WatchCallback | ObjectWatchOptionItem,
  options?: WatchOptions
): WatchStopHandle {
  const publicThis = this.proxy as any
  const getter = isString(source)
    ? source.includes('.')
      ? createPathGetter(publicThis, source)
      : () => publicThis[source]
    : source.bind(publicThis, publicThis)
  let cb
  if (isFunction(value)) {
    cb = value
  } else {
    cb = value.handler as Function
    options = value
  }
  const cur = currentInstance
  setCurrentInstance(this)
  const res = doWatch(getter, cb.bind(publicThis), options)
  if (cur) {
    setCurrentInstance(cur)
  } else {
    unsetCurrentInstance()
  }
  return res
}

export function createPathGetter(ctx: any, path: string) {
  const segments = path.split('.')
  return () => {
    let cur = ctx
    for (let i = 0; i < segments.length && cur; i++) {
      cur = cur[segments[i]]
    }
    return cur
  }
}
/**
 * 
 * @param value 对象
 * @param seen 用于暂存访问过的属性，防止出现循环引用的问题
 * @returns 
 */
export function traverse(value: unknown, seen?: Set<unknown>) {
  // 如果value不是对象或value不可被转为代理（经过markRaw处理），直接return value
  if (!isObject(value) || (value as any)[ReactiveFlags.SKIP]) {
    return value
  }
  //sean用于暂存访问过的属性，防止出现循环引用的问题
  //循环引用：constobj = {a:1}; obj.b=obj;
  seen = seen || new Set()
  // 如果seen中已经存在了value，意味着value中存在循环引用的情况，这时return value
  if (seen.has(value)) {
    return value
  }
  //添加value到seen
  seen.add(value)
  //如果是ref，递归访问value.value
  if (isRef(value)) {
    traverse(value.value, seen)
  } else if (isArray(value)) {
    // 如果是数组，遍历数组并调用traverse递归访问元素内的属性
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }
  } else if (isSet(value) || isMap(value)) {
    // 如果是Set或Map，调用traverse递归访问集合中的值
    value.forEach((v: any) => {
      traverse(v, seen)
    })
  } else if (isPlainObject(value)) {
    // 如果是原始对象，调用traverse递归方位value中的属性
    for (const key in value) {
      traverse((value as any)[key], seen)
    }
  }
  //返回value
  return value
}
