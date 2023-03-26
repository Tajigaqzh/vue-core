import { isObject, toRawType, def } from '@vue/shared'
import {
  mutableHandlers,
  readonlyHandlers,
  shallowReactiveHandlers,
  shallowReadonlyHandlers
} from './baseHandlers'
import {
  mutableCollectionHandlers,
  readonlyCollectionHandlers,
  shallowCollectionHandlers,
  shallowReadonlyCollectionHandlers
} from './collectionHandlers'
import type { UnwrapRefSimple, Ref, RawSymbol } from './ref'

export const enum ReactiveFlags {
  SKIP = '__v_skip',
  IS_REACTIVE = '__v_isReactive',
  IS_READONLY = '__v_isReadonly',
  IS_SHALLOW = '__v_isShallow',
  RAW = '__v_raw'
}

export interface Target {
  [ReactiveFlags.SKIP]?: boolean//不做响应式处理的数据
  [ReactiveFlags.IS_REACTIVE]?: boolean//target是否是响应式
  [ReactiveFlags.IS_READONLY]?: boolean//target是否是只读
  [ReactiveFlags.IS_SHALLOW]?: boolean//是否是浅层次
  [ReactiveFlags.RAW]?: any//proxy对应的源数据
}

export const reactiveMap = new WeakMap<Target, any>()
export const shallowReactiveMap = new WeakMap<Target, any>()
export const readonlyMap = new WeakMap<Target, any>()
export const shallowReadonlyMap = new WeakMap<Target, any>()

const enum TargetType {
  //其他对象
  INVALID = 0,
  //object，array对象
  COMMON = 1,
  //map，set，weakmap，weakset
  COLLECTION = 2
}

function targetTypeMap(rawType: string) {
  switch (rawType) {
    case 'Object':
    case 'Array':
      return TargetType.COMMON
    case 'Map':
    case 'Set':
    case 'WeakMap':
    case 'WeakSet':
      return TargetType.COLLECTION
    default:
      return TargetType.INVALID
  }
}

function getTargetType(value: Target) {
  return value[ReactiveFlags.SKIP] || !Object.isExtensible(value)
    ? TargetType.INVALID
    : targetTypeMap(toRawType(value))
}

// only unwrap nested ref
export type UnwrapNestedRefs<T> = T extends Ref ? T : UnwrapRefSimple<T>

/**
 * Creates a reactive copy of the original object.
 *
 * The reactive conversion is "deep"—it affects all nested properties. In the
 * ES2015 Proxy based implementation, the returned proxy is **not** equal to the
 * original object. It is recommended to work exclusively with the reactive
 * proxy and avoid relying on the original object.
 *
 * A reactive object also automatically unwraps refs contained in it, so you
 * don't need to use `.value` when accessing and mutating their value:
 * 
 *创建一个原始对象的reactive副本。这种reactive转换是深层次的，他影响所有嵌套的属性，在es2015基于Proxy的实现中返回的代理对象不等同原始对象
 建议只使用reactive代理并避免依赖原始对象。reactive对象也会自动捷豹其中包含的refs，因此访问和更改其值时不需要使用“.value”：
 * ```js
 * const count = ref(0)
 * const obj = reactive({
 *   count
 * })
 *
 * obj.count++
 * obj.count // -> 1
 * count.value // -> 1
 * ```
 */
//泛型约束
export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>
// reactive源码
export function reactive(target: object) {
  //如果尝试监视一个readonly代理，直接返回readonly
  // if trying to observe a readonly proxy, return the readonly version.
  if (isReadonly(target)) {
    return target
  }
  return createReactiveObject(
    target,
    false,
    mutableHandlers,//用于object，array类创建proxy
    mutableCollectionHandlers,//用于Set，Map，weakMap类创建proxy
    reactiveMap//存放reactive?
  )
}

export declare const ShallowReactiveMarker: unique symbol

export type ShallowReactive<T> = T & { [ShallowReactiveMarker]?: true }

/**
 * Return a shallowly-reactive copy of the original object, where only the root
 * level properties are reactive. It also does not auto-unwrap refs (even at the
 * root level).
 */
export function shallowReactive<T extends object>(
  target: T
): ShallowReactive<T> {
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    shallowCollectionHandlers,
    shallowReactiveMap
  )
}

type Primitive = string | number | boolean | bigint | symbol | undefined | null
type Builtin = Primitive | Function | Date | Error | RegExp
export type DeepReadonly<T> = T extends Builtin
  ? T
  : T extends Map<infer K, infer V>
  ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends ReadonlyMap<infer K, infer V>
  ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends WeakMap<infer K, infer V>
  ? WeakMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends Set<infer U>
  ? ReadonlySet<DeepReadonly<U>>
  : T extends ReadonlySet<infer U>
  ? ReadonlySet<DeepReadonly<U>>
  : T extends WeakSet<infer U>
  ? WeakSet<DeepReadonly<U>>
  : T extends Promise<infer U>
  ? Promise<DeepReadonly<U>>
  : T extends Ref<infer U>
  ? Readonly<Ref<DeepReadonly<U>>>
  : T extends {}
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : Readonly<T>

/**
 * Creates a readonly copy of the original object. Note the returned copy is not
 * made reactive, but `readonly` can be called on an already reactive object.
 * 创建原始对象的只读副本。请注意，返回的副本不是reactive对象，但可以对已经reactive的对象调用“readonly”。
 */
export function readonly<T extends object>(
  target: T
): DeepReadonly<UnwrapNestedRefs<T>> {
  return createReactiveObject(
    target,
    true,
    readonlyHandlers,
    readonlyCollectionHandlers,
    readonlyMap
  )
}

/**
 * Returns a reactive-copy of the original object, where only the root level
 * properties are readonly, and does NOT unwrap refs nor recursively convert
 * returned properties.
 * This is used for creating the props proxy object for stateful components.
 */
export function shallowReadonly<T extends object>(target: T): Readonly<T> {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    shallowReadonlyCollectionHandlers,
    shallowReadonlyMap
  )
}
/**
 * @description 创建reactive对象
 * @param target 源对象
 * @param isReadonly 是否是只读
 * @param baseHandlers 基本的handlers
 * @param collectionHandlers 主要针对set，map，weakSet，weakMap的handlers
 */
function createReactiveObject(
  target: Target,
  isReadonly: boolean,
  baseHandlers: ProxyHandler<any>,//基础的拦截器
  collectionHandlers: ProxyHandler<any>,//集合拦截器
  proxyMap: WeakMap<Target, any>
  //代理对象缓存池。键：原始对象；值：proxy（代理后对象）或者其他
  //WeakMap的键值只针对一个object对象的数据，并且weakMap的键名所指向的对象，不计入垃圾回收机制
  //他的键名所引用的对象都是弱引用，垃圾回收机制不将该引用考虑在内
  //只要所应用的对象的其他引用都被清除，垃圾回收机制就会释放该对象所占用的内存
  //也就是说一旦不再需要，weakMap里面的键名对象和所引用的对象就会自动消失，不用手动删除
) {
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
  // target is already a Proxy, return it.
  // exception: calling readonly() on a reactive object
  //如果该对象已经被代理，直接返回。特殊情况：readonly(T:Reactive)
  //已经经是响应式的就直接返回(取ReactiveFlags.RAW 属性会返回true，因为进行reactive的过程中会用weakMap进行保存，
  //通过target能判断出是否有ReactiveFlags.RAW属性
  if (
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }
  // target already has corresponding Proxy
  //从缓存readonlyMap，reactiveMap中查找，如果target对象已被代理直接返回
  const existingProxy = proxyMap.get(target)
  if (existingProxy) {
    return existingProxy
  }
  // only specific value types can be observed.
  //如果在白名单中直接返回如__skip__
  const targetType = getTargetType(target)
  if (targetType === TargetType.INVALID) {
    return target
  }

  //proxy代理
  const proxy = new Proxy(
    target,
    /* 根据判断对象类型添加响应拦截器
    当new Proxy(target, handler)时，这里的handler有两种：
    一种是针对Object、Array的baseHandlers，一种是针对集合（Set、Map、WeakMap、WeakSet）的collectionHandlers。
    对于Object、Array、集合这几种数据类型，如果使用proxy捕获它们的读取或修改操作，其实是不一样的。
    比如捕获修改操作进行依赖触发时，Object可以直接通过set（或deleteProperty）捕获器，
    而Array是可以通过pop、push等方法进行修改数组的，
    所以需要捕获它的get操作进行单独处理，
    同样对于集合来说，也需要通过捕获get方法来处理修改操作。*/
    targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers
  )
  //缓存代理对象。键：原始对象；值代理对象
  proxyMap.set(target, proxy)
  return proxy
}
/**
 * 判断是否是reactive
 * @param value 要判断的值
 * @returns boolean
 */
export function isReactive(value: unknown): boolean {
  if (isReadonly(value)) {
    return isReactive((value as Target)[ReactiveFlags.RAW])
  }
  /* 
  !：
    1、用在变量前表示取反
    2、用在赋值的内容后时:表示类型推断排除null、undefined
  !!与??:
  !! 将一个其他类型转换成boolean类型，类似于Boolean()
  ?? 空值合并操作符，当操作符的左侧是null或者undefined时，返回其右侧操作数，否则返回左侧操作数
  !!:由于对null与undefined用 ! 操作符时都会产生true的结果，所以用两个感叹号的作用就在于，
  如果设置了o中flag的值（非 null/undefined/0""/等值），自然test就会取跟o.flag一样的值；
  如果没有设置，test就会默认为false，而不是 null或undefined。
*/
  return !!(value && (value as Target)[ReactiveFlags.IS_REACTIVE])
}


export function isReadonly(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_READONLY])
}

export function isShallow(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_SHALLOW])
}

export function isProxy(value: unknown): boolean {
  return isReactive(value) || isReadonly(value)
}

export function toRaw<T>(observed: T): T {
  const raw = observed && (observed as Target)[ReactiveFlags.RAW]
  return raw ? toRaw(raw) : observed
}

export type Raw<T> = T & { [RawSymbol]?: true }

export function markRaw<T extends object>(value: T): Raw<T> {
  def(value, ReactiveFlags.SKIP, true)
  return value
}

export const toReactive = <T extends unknown>(value: T): T =>
//判断是不是Object类型，是的话调用reactive，不是就返回
  isObject(value) ? reactive(value) : value

export const toReadonly = <T extends unknown>(value: T): T =>
  isObject(value) ? readonly(value as Record<any, any>) : value
