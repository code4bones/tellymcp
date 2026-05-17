/*
 * moleculer-apollo-server
 *
 * Apollo Server for Moleculer API Gateway.
 *
 * Based on "apollo-server-micro"
 *
 * 		https://github.com/apollographql/apollo-server/blob/master/packages/apollo-server-micro/
 *
 *
 * Copyright (c) 2020 MoleculerJS (https://github.com/moleculerjs/moleculer-apollo-server)
 * MIT Licensed
 */

import { GraphQLError } from "graphql";

// const GraphQLUpload = require("graphql-upload");
import { ApolloServer } from "./ApolloServer";
import ApolloService from "./service";
import { gql } from "./gql";

export { GraphQLError, ApolloServer, ApolloService, gql };
