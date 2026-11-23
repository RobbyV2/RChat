import { client } from '../client/client'

// Legacy fixtures exercise the initial page connection.
export const home = client.homeInstance()
export const api = home.api
