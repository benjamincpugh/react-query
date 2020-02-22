import {
  isServer,
  functionalUpdate,
  cancelledError,
  isDocumentVisible,
  statusLoading,
  statusSuccess,
  statusError,
  getQueryArgs,
  uid,
  noop,
} from './utils'
import { defaultConfigRef } from './config'

export const queryCache = makeQueryCache()

export const actionInit = {}
export const actionActivate = {}
export const actionDeactivate = {}
export const actionFailed = {}
export const actionMarkStale = {}
export const actionFetch = {}
export const actionSuccess = {}
export const actionError = {}
export const actionSetData = {}

export function makeQueryCache() {
  const listeners = []

  const cache = {
    queries: {},
    isFetching: 0,
  }

  const notifyGlobalListeners = () => {
    listeners.forEach(d => d(cache))
    cache.isFetching = Object.values(queryCache.queries).filter(
      query => query.state.isFetching
    ).length
  }

  cache.subscribe = cb => {
    listeners.push(cb)
    return () => {
      listeners.splice(listeners.indexOf(cb), 1)
    }
  }

  cache.clear = () => {
    cache.queries = {}
    notifyGlobalListeners()
  }

  const findQueries = (predicate, { exact } = {}) => {
    if (typeof predicate !== 'function') {
      const [queryHash] = defaultConfigRef.current.queryKeySerializerFn(
        predicate
      )
      predicate = d =>
        exact ? d.queryHash === queryHash : d.queryHash.startsWith(queryHash)
    }

    const found = Object.values(cache.queries).filter(predicate)

    return exact ? found[0] : found
  }

  cache.getQueryData = queryKey =>
    findQueries(queryKey, { exact: true })?.state.data

  cache.removeQueries = (predicate, { exact } = {}) => {
    const foundQueries = findQueries(predicate, { exact })

    foundQueries.forEach(query => {
      delete cache.queries[query.queryhash]
    })

    if (foundQueries.length) {
      notifyGlobalListeners()
    }
  }

  cache.refetchQueries = (predicate, { exact, throwOnError } = {}) => {
    const foundQueries = (predicate === true
      ? Object.values(cache.queries)
      : findQueries(predicate, { exact })
    ).filter(query => query.instances.length)

    try {
      return Promise.all(foundQueries.map(query => query.fetch()))
    } catch (err) {
      if (throwOnError) {
        throw err
      }
    }
  }

  cache._buildQuery = (userQueryKey, queryVariables, queryFn, config) => {
    let [queryHash, queryKey] = config.queryKeySerializerFn(userQueryKey)

    let query = cache.queries[queryHash]

    if (query) {
      Object.assign(query, { queryVariables, queryFn })
      Object.assign(query.config, config)
    } else {
      query = makeQuery({
        queryKey,
        queryHash,
        queryVariables,
        queryFn,
        config,
      })

      query.heal()
      query.scheduleGarbageCollection()

      if (!isServer) {
        cache.queries[queryHash] = query
      }
    }

    return query
  }

  cache.prefetchQuery = async args => {
    let [queryKey, queryVariables, queryFn, config] = getQueryArgs(args)

    const query = cache._buildQuery(queryKey, queryVariables, queryFn, {
      ...defaultConfigRef.current,
      ...config,
    })

    // Trigger a fetch and return the promise
    try {
      return query.fetch()
    } catch (err) {
      if (config.throwOnError) {
        throw err
      }
    }
  }

  cache.setQueryData = (queryKey, updater) => {
    const query = cache._buildQuery(
      queryKey,
      undefined,
      () => new Promise(noop),
      defaultConfigRef.current
    )

    query.setData(updater)
  }

  function makeQuery(options) {
    const reducer = options.config.queryReducer || defaultQueryReducer

    const query = {
      ...options,
      instances: [],
      state: reducer(undefined, {
        type: actionInit,
        initialData: options.config.initialData,
        manual: options.config.manual,
      }),
    }

    const dispatch = action => {
      query.state = reducer(query.state, action)
      query.instances.forEach(d => d.onStateUpdate(query.state))
      notifyGlobalListeners()
    }

    query.scheduleGarbageCollection = () => {
      query.isInactive = true

      query.cacheTimeout = setTimeout(() => {
        cache.removeQueries(d => d.queryHash === query.queryhash)
      }, query.config.cacheTime)
    }

    query.heal = () => {
      // Mark the query as active
      query.isInactive = false

      // Stop the query from being garbage collected
      clearTimeout(query.cacheTimeout)

      // Mark the query as not cancelled
      query.cancelled = null
    }

    query.subscribe = instance => {
      let found = query.instances.find(d => d.id === instance.id)

      if (found) {
        Object.assign(found, instance)
      } else {
        found = {
          onStateUpdate: noop,
          ...instance,
        }
        query.instances.push(instance)
      }

      query.heal()

      // Return the unsubscribe function
      return () => {
        query.instances = query.instances.filter(d => d.id !== instance.id)

        if (!query.instances.length) {
          // Cancel any side-effects
          query.cancelled = cancelledError

          if (query.cancelQueries) {
            query.cancelQueries()
          }

          // Schedule garbage collection
          query.scheduleGarbageCollection()
        }
      }
    }

    // Set up the fetch function
    const tryFetchData = async (queryFn, ...args) => {
      try {
        // Perform the query
        const promise = queryFn(...args)

        query.cancelQueries = () => promise?.cancel?.()

        const data = await promise

        if (query.cancelled) throw query.cancelled

        return data
      } catch (error) {
        if (query.cancelled) throw query.cancelled

        // If we fail, increase the failureCount
        dispatch({ type: actionFailed })

        // Do we need to retry the request?
        if (
          // Only retry if the document is visible
          query.config.retry === true ||
          query.state.failureCount < query.config.retry
        ) {
          if (!isDocumentVisible()) {
            return new Promise(noop)
          }

          // Determine the retryDelay
          const delay = functionalUpdate(
            query.config.retryDelay,
            query.state.failureCount
          )

          // Return a new promise with the retry
          return new Promise((resolve, reject) => {
            // Keep track of the retry timeout
            setTimeout(async () => {
              if (query.cancelled) return reject(query.cancelled)

              try {
                const data = await tryFetchData(queryFn, ...args)
                if (query.cancelled) return reject(query.cancelled)
                resolve(data)
              } catch (error) {
                if (query.cancelled) return reject(query.cancelled)
                reject(error)
              }
            }, delay)
          })
        }

        throw error
      }
    }

    query.fetch = async ({ __queryFn = query.queryFn } = {}) => {
      // Don't refetch fresh queries that don't have a queryHash
      if (!query.queryHash) {
        return
      }

      // Create a new promise for the query cache if necessary
      if (!query.promise) {
        query.promise = (async () => {
          // If there are any retries pending for this query, kill them
          query.cancelled = null

          const cleanup = () => {
            delete query.promise

            // Schedule a fresh invalidation, always!
            clearTimeout(query.staleTimeout)

            query.staleTimeout = setTimeout(() => {
              if (query) {
                dispatch({ type: actionMarkStale })
              }
            }, query.config.staleTime)
          }

          try {
            // Set up the query refreshing state
            dispatch({ type: actionFetch })

            // Try to fetch
            let data = await tryFetchData(
              __queryFn,
              ...query.queryKey,
              ...query.queryVariables
            )

            // Set data and mark it as cached
            dispatch({
              type: actionSuccess,
              data,
            })

            query.instances.forEach(
              instance =>
                instance.onSuccess && instance.onSuccess(query.state.data)
            )

            query.instances.forEach(
              instance =>
                instance.onSettled && instance.onSettled(query.state.data, null)
            )

            cleanup()

            return data
          } catch (error) {
            dispatch({
              type: actionError,
              cancelled: error === query.cancelled,
              error,
            })

            cleanup()

            if (error !== query.cancelled) {
              query.instances.forEach(
                instance => instance.onError && instance.onError(error)
              )

              query.instances.forEach(
                instance =>
                  instance.onSettled && instance.onSettled(undefined, error)
              )

              throw error
            }
          }
        })()
      }

      return query.promise
    }

    query.setData = updater => dispatch({ type: actionSetData, updater })

    return query
  }

  return cache
}

export function defaultQueryReducer(state, action) {
  switch (action.type) {
    case actionInit:
      return {
        status:
          action.manual || action.initialData ? statusSuccess : statusLoading,
        error: null,
        isFetching: !action.manual,
        canFetchMore: false,
        failureCount: 0,
        isStale: true,
        isInactive: false,
        data: action.initialData,
      }
    case actionActivate:
      return {
        ...state,
        isInactive: false,
      }
    case actionDeactivate:
      return {
        ...state,
        isInactive: true,
      }
    case actionFailed:
      return {
        ...state,
        failureCount: state.failureCount + 1,
      }
    case actionMarkStale:
      return {
        ...state,
        isStale: true,
      }
    case actionFetch:
      return {
        ...state,
        status: state.status === statusError ? statusLoading : state.status,
        isFetching: true,
        failureCount: 0,
      }
    case actionSuccess:
      return {
        ...state,
        status: statusSuccess,
        data: action.data,
        error: null,
        isStale: false,
        isFetching: false,
        canFetchMore: action.canFetchMore,
      }
    case actionError:
      return {
        ...state,
        isFetching: false,
        ...(!action.cancelled && {
          status: statusError,
          error: action.error,
          isStale: true,
        }),
      }
    case actionSetData:
      return {
        ...state,
        data: functionalUpdate(action.updater, state.data),
      }
    default:
      throw new Error()
  }
}